FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 sshfs openssh-server fuse3 procps bc \
    && rm -rf /var/lib/apt/lists/*

# Allow non-root FUSE mounts
RUN echo 'user_allow_other' >> /etc/fuse.conf

# SSH loopback for sshfs: fuseuser serves files via SFTP,
# root mounts them via sshfs to create a FUSE filesystem.
RUN mkdir -p /run/sshd && \
    ssh-keygen -A && \
    useradd -m -s /bin/bash fuseuser && \
    echo 'fuseuser:fusepass' | chpasswd && \
    mkdir -p /root/.ssh && \
    ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N '' && \
    mkdir -p /home/fuseuser/.ssh && \
    cp /root/.ssh/id_ed25519.pub /home/fuseuser/.ssh/authorized_keys && \
    chown -R fuseuser:fuseuser /home/fuseuser/.ssh && \
    chmod 700 /home/fuseuser/.ssh && \
    chmod 600 /home/fuseuser/.ssh/authorized_keys

# FUSE backing directory (served by sshfs via SFTP)
RUN mkdir -p /srv/fuse-data && chown fuseuser:fuseuser /srv/fuse-data

# Mount point
RUN mkdir -p /mnt/fuse

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
