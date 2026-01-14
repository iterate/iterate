# Architecture

The iterate platform consists of two parts.

There is a control plane, which is our hosted offering. It runs on Cloudflare and handles things like secrets management, provisioning machines and overall management of the platform. `apps/os/backend` contains all the APIs for this. `apps/os/app` is the webapp for the cloud platform, which talks to the backend over TRPC.

The second part are the 'machines'. The machine has a daemon that controls multiple AI agents and provides a HTTP server, and communicates with the control plane. The machine is intended to be standalone and self-hostable. It should be infrastructure agnostic. A machine should not care whether it is being controlled by the control plane or not - you should be able to run it without the control plane. Eventually the control plane may seamlessly spread out tasks across multiple machines.
