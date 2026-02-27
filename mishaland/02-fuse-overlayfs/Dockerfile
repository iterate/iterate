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

# Prepare directories
RUN mkdir -p /opt/lower-dir /opt/fuse-staging /opt/merged /opt/work && \
    chown testuser:testuser /opt/fuse-staging && \
    echo "I am a file from the lower layer" > /opt/lower-dir/existing-file.txt

RUN echo 'user_allow_other' >> /etc/fuse.conf

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
