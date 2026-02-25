---
state: todo
---

# Customer Config repo

## Goal

Allow customers to connect their github account and chose a repo as their config repo, AKA the iterate repo.
Right now we use `repo-templates/default` to find and load the iterate.config.ts file, what we want is to specify this folder.

## What this allows

With this we can

- Load the iterate.config.ts file from the customer's repo
- Allow customers to specify processes they want to run when the machine starts
- In future, store skills,tools, etc in the repo
- Allow Iterate to modify this repo and make PR against it to make changes to itself

## What needs to happen

We already have a github login flow, we need to add UI for selecting the config repo, then update the db to store the repo id.
When the machine starts, we clone this repo to the machine and point the config loader to the cloned repo, it will import the iterate.config.ts file from the config repo.
The loader will take care of reconciling user land processes and stuff
