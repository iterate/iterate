FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    sshfs openssh-server fuse3 git time bc \
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

RUN corepack enable && corepack prepare pnpm@9 --activate

# Clone the real iterate repo and install deps on LOCAL disk at build time
# This simulates the Docker image having the repo baked in
RUN git clone --depth 1 https://github.com/iterate/iterate.git /home/testuser/src/iterate || \
    (mkdir -p /home/testuser/src/iterate && \
     cd /home/testuser/src/iterate && \
     npm init -y && \
     npm install lodash typescript && \
     echo 'console.log("hello from iterate")' > index.js)
# Try the real repo; if unavailable, create a minimal project with real node_modules
RUN cd /home/testuser/src/iterate && \
    (pnpm install --frozen-lockfile 2>/dev/null || pnpm install 2>/dev/null || true) && \
    chown -R testuser:testuser /home/testuser

# Create dotfiles in home (simulating the Docker image skeleton)
RUN printf 'export PATH="/usr/local/bin:$PATH"\n' > /home/testuser/.bashrc && \
    printf 'source ~/.bashrc\n' > /home/testuser/.profile && \
    printf '[user]\n  name = Test User\n  email = test@example.com\n' > /home/testuser/.gitconfig && \
    mkdir -p /home/testuser/.config/opencode && \
    echo '{"theme":"dark"}' > /home/testuser/.config/opencode/config.json && \
    mkdir -p /home/testuser/.iterate && \
    echo 'SOME_KEY=value' > /home/testuser/.iterate/.env && \
    chown -R testuser:testuser /home/testuser

# Create the FUSE backing directory
RUN mkdir -p /srv/persist-data && chown testuser:testuser /srv/persist-data

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
