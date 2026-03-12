I would like to clean up our Cloudflare zones so that the iterate.com zone is exclusively used for production things. Iterate.app is used for the Cloudflare SaaS origin, and we should not have the /_/_ workers ingress route on the iterate.com.

We also need to have a clear view. There should be something that is basically symmetrical to iterate.com and iterate.app, and for the lack of a better option, I would say iteratestaging.com and iteratestaging.app might be things we should add.

iterate-stg.com
iterate-stg.app
