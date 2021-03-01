const exec = require('child_process').exec;
const winston = require('winston');
const cron = require('node-cron');
const Transport = require('winston-transport');
const Discord = require('discord.js');
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

async function sh(cmd) {
    return new Promise(function (resolve, reject) {
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

const args = process.argv.slice(2);

const discordHook = new Discord.WebhookClient(process.env.DISCORD_WEBHOOK_ID, process.env.DISCORD_WEBHOOK_TOKEN);
const discordCharacterLimit = 1900;

const backupCron = process.env.BACKUP_CRON || '0 */6 * * *'
const checkCron = process.env.CHECK_CRON || '0 7 * * 1'
const pruneCron = process.env.PRUNE_CRON || '0 1 1 * *'

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

    let { stdout, stderr } = await sh(cmd);
    for (let line of stdout.split('\n')) {
        logger.info(`retic: ${line}`);
    }
    for (let line of stderr.split('\n')) {
        logger.warn(`retic err: ${line}`);
    }
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
        logger.warn(`Backup / forget failed (${e.code}): ${e.message}`)
    }

    notifyDiscord();
}

async function checkWeeklySubset() {
    try {
        let week = getISOWeek(new Date(), { weekStartsOn: 1 })

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
        discordHook.destroy();
    })();
} else if (job == 'check') {
    (async () => {
        await checkWeeklySubset();
        discordHook.destroy();
    })();
} else if (job == 'prune') {
    (async () => {
        await prune();
        discordHook.destroy();
    })();
} else {
    logger.error(`Unknown command '${job}'`)
}
