const exec = require('child_process').exec;
const winston = require('winston');
const cron = require('node-cron');
const Transport = require('winston-transport');
const Discord = require('discord.js');

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

const cronSchedule = process.env.BACKUP_CRON || '0 */6 * * *'

const backupArgs = process.env.RESTIC_JOB_ARGS || '';
const forgetArgs = process.env.RESTIC_FORGET_ARGS || '';

const rcloneArgs = `serve restic --stdio --b2-hard-delete --drive-use-trash=false --fast-list --transfers=32`

const backupCommand = `restic backup /data ${backupArgs} -o rclone.args="${rcloneArgs}"`
const forgetCommand = `restic forget ${forgetArgs} -o rclone.args="${rcloneArgs}"`
const unlockCommand = `restic unlock -o rclone.args="${rcloneArgs}"`

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

async function unlock() {
    await runAndLogRestic(unlockCommand);
}

async function backup() {
    await runAndLogRestic(backupCommand);
}

async function forget() {
    await runAndLogRestic(forgetCommand);
}

function notifyDiscord() {
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
}

async function main() {
    try {
        await backup();
        logger.info(`Backup succesful`);
        await forget();
        logger.info('Forget succesful')
    } catch (e) {
        logger.warn(`Backup / forget failed (${e.code}): ${e.message}`)
        try {
            await unlock()
        } catch (e) {
            logger.warn(`Unlock failed (${e.code}): ${e.message}`)
        }
    }

    notifyDiscord();
}

if (args.length > 0 && args[0] == 'cron') {
    cron.schedule(cronSchedule, () => {
        main()
    });

    logger.info(`Application started with schedule '${cronSchedule}'`)
} else {
    (async () => {
        await main();
        discordHook.destroy();
    })();
}