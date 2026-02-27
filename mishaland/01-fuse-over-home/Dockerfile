FROM node:20-bookworm

# Install sshfs (FUSE filesystem), openssh for the loopback trick
RUN apt-get update && apt-get install -y --no-install-recommends \
    sshfs openssh-server fuse3 git time procps rsync \
    && rm -rf /var/lib/apt/lists/*

# Allow non-root FUSE mounts with allow_other
RUN echo 'user_allow_other' >> /etc/fuse.conf

# Setup SSH for loopback sshfs
# We create two users:
#   - testuser: simulates the app user, home at /home/testuser (will be FUSE-mounted)
#   - fuseuser: used only for SSH/SFTP, home at /home/fuseuser (never mounted over)
# This avoids a circular dependency where sshd tries to cd to /home/testuser
# which is the FUSE mount backed by the same sshd.
RUN mkdir -p /run/sshd && \
    ssh-keygen -A && \
    useradd -m -s /bin/bash testuser && \
    useradd -m -s /bin/bash fuseuser && \
    echo 'fuseuser:fusepass' | chpasswd && \
    mkdir -p /root/.ssh && \
    ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N '' && \
    mkdir -p /home/fuseuser/.ssh && \
    cp /root/.ssh/id_ed25519.pub /home/fuseuser/.ssh/authorized_keys && \
    chown -R fuseuser:fuseuser /home/fuseuser/.ssh && \
    chmod 700 /home/fuseuser/.ssh && \
    chmod 600 /home/fuseuser/.ssh/authorized_keys

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Clone the real iterate/iterate repo (public) and install deps on LOCAL disk.
# This gives us a realistic node_modules tree with ~50K files.
# The lockfile ensures reproducible installs for fair comparison.
RUN git clone --depth 1 https://github.com/iterate/iterate.git /opt/iterate && \
    cd /opt/iterate && \
    pnpm install --frozen-lockfile && \
    rm -rf /root/.local/share/pnpm/store

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
