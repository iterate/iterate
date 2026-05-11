we should not store a list of ALL children in each stream state - that won't scale (especially for the "/" stream)

The rule is that the number of events can be practically unlimited, but the state must not grow very big

So we can totally make an orpc procedure to "list all streams", but it needs to be an async iterator that iterates over a filtered event stream (that eventually will pull from R2 etc)

And destroy should just recurse to the immediate children and then again and again etc
