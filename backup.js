const spawn = require('child_process').spawn;
const winston = require('winston');
const cron = require('node-cron');
const Transport = require('winston-transport');
const Discord = require('discord.js');
const readline = require('readline');
var getISOWeek = require('date-fns/getISOWeek')

require('winston-daily-rotate-file');

class CollectorTransport extends Transport {
    constructor(opts) {
        super(opts);
    }

    logs = [];

    resetCollection() {
        this.logs = [];
    }

    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        this.logs.push(`${info.level}: ${info.message}`)

        callback();
    }

    getCollection() {
        return this.logs;
    }
}

const collectorTransport = new CollectorTransport({
    handleExceptions: true
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [
        collectorTransport,
        new winston.transports.Console({
            handleExceptions: true
        }),
        new winston.transports.DailyRotateFile({
            filename: '/var/log/backup-%DATE%.log',
            datePattern: 'YYYY-MM-DD-HH',
            zippedArchive: false,
            maxSize: '20m',
            maxFiles: '14d',
            handleExceptions: true
        })
    ],
});

async function sh(cmd, env) {
    const output = await spawn(cmd, {shell: true, env: {...process.env, ...env}})

    const readLineStdout = readline.createInterface({ input: output.stdout });
    const readLineStderr = readline.createInterface({ input: output.stderr });

    readLineStdout.on('line', line => {
        logger.info(`retic: ${line}`);
    })

    readLineStderr.on('line', line => {
        logger.warn(`retic err: ${line}`);
    })

    const exitCode = await new Promise((resolve, reject) => {
        output.on('close', resolve);
    });

    if (exitCode) {
        throw new Error(`subprocess error exit ${exitCode}`);
    }
}

const args = process.argv.slice(2);

let discordEnabled = false
let discordHook;
if (process.env.DISCORD_WEBHOOK_ID && process.env.DISCORD_WEBHOOK_TOKEN) {
    discordHook = new Discord.WebhookClient(process.env.DISCORD_WEBHOOK_ID, process.env.DISCORD_WEBHOOK_TOKEN);
}

const discordCharacterLimit = 1900;

const backupCron = process.env.BACKUP_CRON || '0 */6 * * *'
const checkCron = process.env.CHECK_CRON || '0 7 * * 1'
const pruneCron = process.env.PRUNE_CRON || '0 1 2 * *'

const backupArgs = process.env.RESTIC_JOB_ARGS || '';
const forgetArgs = process.env.RESTIC_FORGET_ARGS || '';
const checkArgs = process.env.RESTIC_CHECK_ARGS || '';
const pruneArgs = process.env.RESTIC_PRUNE_ARGS || '';

const rcloneArgs = `serve restic --stdio --b2-hard-delete --drive-use-trash=false --fast-list --transfers=32`

const backupCommand = `restic backup /data ${backupArgs} -o rclone.args="${rcloneArgs}"`
const forgetCommand = `restic forget ${forgetArgs} -o rclone.args="${rcloneArgs}"`
const checkWeeklySubsetCommand = `restic check ${checkArgs} --read-data-subset=<week>/52 -o rclone.args="${rcloneArgs}"`
const pruneCommand = `restic prune ${pruneArgs} -o rclone.args="${rcloneArgs}"`

function notifyDiscord() {
    try {
        const logs = collectorTransport.getCollection()
        collectorTransport.resetCollection()

        if (!discordEnabled) {
            return;
        }

        let buffer = []
        for (const log of logs) {
            const out = `${buffer.join('\n')}\n${log}`
            if (out.length >= discordCharacterLimit) {
                discordHook.send(`\`\`\`${buffer.join('\n')}\`\`\``);
                buffer = [];
            }

            buffer.push(log)
        }

        discordHook.send(`\`\`\`${buffer.join('\n')}\`\`\``);
    } catch (e) {
        logger.error(`Discord notification failed (${e.code}): ${e.message}`)
    }
}

async function runAndLogRestic(cmd) {
    logger.info(`Running '${cmd}'`)

    await sh(cmd);
}

async function backup() {
    await runAndLogRestic(backupCommand);
}

async function forget() {
    await runAndLogRestic(forgetCommand);
}

async function backupAndForget() {
    try {
        await backup();
        logger.info(`Backup succesful`);
        await forget();
        logger.info('Forget succesful')
    } catch (e) {
        logger.warn(`Backup / forget failed: ${e.message}`)
    }

    notifyDiscord();
}

async function checkWeeklySubset() {
    try {
        let week = getISOWeek(new Date(), {weekStartsOn: 1})

        if (week > 52) {
            week = 52;
        }

        const cmd = checkWeeklySubsetCommand.replace('<week>', week)
        await runAndLogRestic(cmd)
        logger.info(`Check succesful`);
    } catch (e) {
        logger.warn(`Check failed (${e.code}): ${e.message}`)
    }

    notifyDiscord();
}

async function prune() {
    try {
        await runAndLogRestic(pruneCommand);
        logger.info(`Prune succesful`);
    } catch (e) {
        logger.warn(`Prune failed (${e.code}): ${e.message}`)
    }

    notifyDiscord();
}

function stop() {
    if (discordEnabled) {
        discordHook.destroy();
    }
}

let job = 'backup';
if (args.length > 0) {
    job = args[0]
}

if (job == 'cron') {
    cron.schedule(backupCron, () => {
        backupAndForget()
    });

    cron.schedule(checkCron, () => {
        checkWeeklySubset()
    });

    cron.schedule(pruneCron, () => {
        prune()
    });

    logger.info(`Application started`)
    logger.info(`Backup cron '${backupCron}'`)
    logger.info(`Check cron '${checkCron}'`)
    logger.info(`Prune cron '${pruneCron}'`)
} else if (job == 'backup') {
    (async () => {
        await backupAndForget();
        stop();
    })();
} else if (job == 'check') {
    (async () => {
        await checkWeeklySubset();
        stop();
    })();
} else if (job == 'prune') {
    (async () => {
        await prune();
        stop();
    })();
} else {
    logger.error(`Unknown command '${job}'`)
}
