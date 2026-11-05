# Groundhog on boxd

Your agent builds a sign-up flow on a [boxd](https://boxd.sh/) machine, then needs to test it. The app sends a verification email, and the agent has nowhere to read it. Run Groundhog on the machine and it can: the app's mail is caught locally, and the agent reads the code from an API.

Nothing leaves the machine, so tests never reach real people.

## Start Groundhog

Create a machine and start Groundhog in the background:

```bash
boxd new my-app
boxd connect my-app
```

```bash
setsid nohup npx -y @groundmail/groundhog > /tmp/groundhog.log 2>&1 < /dev/null &
```

The first start downloads the package, so give it a few seconds. Groundhog listens on `localhost`: SMTP on port 1025, and the inbox and APIs on port 3025.

## Point your app at it

Use SMTP at `localhost:1025` with any username and password, or change your provider SDK's base URL. See the [README](../README.md) for each provider.

## Read the code

Have the agent trigger the email, then wait for it:

```bash
curl -s 'localhost:3025/api/wait?to=agent@example.com&timeout=30000'
```

The call returns when a match arrives. The response has `code` and `links` already pulled out, so the agent can finish the flow.

## One inbox per machine

Save the machine once Groundhog is running:

```bash
boxd snapshots save my-app groundhog
```

Every machine you create from the snapshot starts with Groundhog already running and its own copy of the inbox. That suits one machine per pull request or per agent:

```bash
boxd new pr-123 --from-snapshot groundhog
```

Clear the inbox first if the snapshot caught anything:

```bash
curl -s -X DELETE localhost:3025/api/emails
```

Forks work the same way. Each copy has its own inbox, so one agent's tests can't see another's.

## See the inbox in a browser

Groundhog has no login. **If you publish it, anyone with the URL can read what it caught.** Only do this on a machine with test data.

```bash
GROUNDHOG_HOST=0.0.0.0 GROUNDHOG_HTTP_PORT=8000 npx -y @groundmail/groundhog
```

The inbox is then at your machine's `https://` address, because boxd serves port 8000 by default.
