FROM node:20-bookworm

# Install sshfs (FUSE filesystem), openssh for the loopback trick
RUN apt-get update && apt-get install -y --no-install-recommends \
    sshfs openssh-server fuse3 git time procps \
    && rm -rf /var/lib/apt/lists/*

# Allow non-root FUSE mounts with allow_other
RUN echo 'user_allow_other' >> /etc/fuse.conf

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
