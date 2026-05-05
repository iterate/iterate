I would like to clean up our Cloudflare zones and accounts so that the iterate.com zone is exclusively used for production things. Iterate.app is used for the Cloudflare SaaS origin, and we should not have the /_/_ workers ingress route on the iterate.com.

We also need to have a clear view. There should be something that is basically symmetrical to iterate.com and iterate.app for numbered preview environment configs.

iterate-preview-N.com
iterate-preview-N.app
