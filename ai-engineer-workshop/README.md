# AI engineer workshop

I was thinking the contents of this folder could maybe become a repo everyone plays in where

- each student (and each of us) have our own folder
- each student folder (or their subfolders) are npm packages
- they can import a lightweight sdk that is exported from apps/events directly. it includes
  - orpc client
  - shared components to make nice web UI renderers
  - any helper libraries e.g. to help people create a "stream processor" or to "discover all streams that start with /jonas/ and subscribe to them"

Something like that anyway :D The stuff in 01-hello-world is mostly vibe-slop

I think it might actually maybe be nice to structure the workshop "exercises" or "demos" or whatever using a trpc-cli based cli after all. You could have `pnpm cli` list out the available demonstrations to run and collect inputs etc - not sure it's worth the effort, though

With what we have here, we should already be able to make a basic codemode agent, for example

With the caveat that the stream processors are all _pulling_ from the streams. Tomorrow I'll make it possible for the streams to also _push_ to the processors that are deployed as serverless workers and then things really get interesting
