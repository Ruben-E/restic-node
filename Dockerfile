FROM restic/restic:0.11.0 as restic
FROM node:alpine

RUN apk add --update --no-cache heirloom-mailx fuse curl ca-certificates openssh-client tzdata

ADD https://downloads.rclone.org/rclone-current-linux-amd64.zip /
RUN unzip rclone-current-linux-amd64.zip && mv rclone-*-linux-amd64/rclone /bin/rclone && chmod +x /bin/rclone

COPY --from=restic /usr/bin/restic /usr/bin/restic

RUN mkdir -p /mnt/restic /var/log;

VOLUME /data

COPY node_modules /app/node_modules
COPY backup.js /app/backup.js

ENTRYPOINT ["node","/app/backup.js","cron"]