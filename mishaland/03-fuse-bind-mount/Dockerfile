FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    sshfs openssh-server fuse3 \
    && rm -rf /var/lib/apt/lists/*

# Setup SSH for loopback sshfs
RUN mkdir -p /run/sshd && \
    ssh-keygen -A && \
    useradd -m -s /bin/bash testuser && \
    echo 'testuser:testpass' | chpasswd && \
    mkdir -p /home/testuser/.ssh && \
    ssh-keygen -t ed25519 -f /home/testuser/.ssh/id_ed25519 -N '' && \
    cp /home/testuser/.ssh/id_ed25519.pub /home/testuser/.ssh/authorized_keys && \
    chown -R testuser:testuser /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chmod 600 /home/testuser/.ssh/authorized_keys

RUN echo 'user_allow_other' >> /etc/fuse.conf

# Create local node_modules content to bind-mount
RUN mkdir -p /var/local-node-modules && \
    echo "local-file-content" > /var/local-node-modules/local-marker.txt && \
    mkdir -p /var/local-node-modules/.pnpm && \
    echo "local-pnpm" > /var/local-node-modules/.pnpm/marker.txt

# Create a project dir that will be on FUSE
RUN mkdir -p /srv/testuser-home/project/node_modules && \
    echo "fuse-file-content" > /srv/testuser-home/project/node_modules/fuse-marker.txt && \
    chown -R testuser:testuser /srv/testuser-home

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
