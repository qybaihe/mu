# relay

A small job queue. Workers pull jobs from the queues in `relay.config.json` and run each with its
queue's timeout, retrying with exponential backoff.
