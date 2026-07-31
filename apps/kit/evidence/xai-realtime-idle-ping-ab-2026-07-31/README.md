# xAI realtime idle `ping` A/B — 2026-07-31

## Question and bounded conclusion

This experiment tested whether failure to answer xAI's application-level JSON
`ping` explains the observed provider WebSocket close after an idle interval.

It does **not reproduce or explain that close on a direct Node-to-xAI path**.
The baseline sent no application `pong` and remained open for the full 45 s;
the reply arm sent the official-client-shaped `pong` and also remained open for
the full 45 s. Both closes were deliberate client closes (`1000`,
`experiment arm complete`), not xAI closes. Therefore an unanswered JSON
`ping` is not sufficient to cause the reported 20–25 s failure, and adding a
`pong` must not be presented as the fix for that failure without a
production-Workerd A/B.

The experiment does establish the live protocol shape:

```json
{
  "type": "ping",
  "event_id": "<uuid>",
  "timestamp": 1785493408391,
  "previous_item_id": null
}
```

The reply used by xAI's official Android client is:

```json
{ "type": "pong", "ping_timestamp": 1785493408391 }
```

## Source inspection

- Current xAI [Speech to Speech guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)
  and [WebSocket API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice)
  were inspected on 2026-07-31. Neither documents `ping` nor `pong`; a search
  of the current official `https://docs.x.ai/llms.txt` also had no match.
- The official `xai-org/xai-cookbook` checkout was pinned at
  `01d842179c4c41c326bd8ce8aa65edce9c9c231d` (commit timestamp
  `2026-04-16T16:38:38+01:00`). Its Android app models incoming `ping.timestamp`
  and responds with `pong.ping_timestamp` in:
  `Android/VoiceApiAndroidExample/app/src/main/java/ai/x/voiceapiandroidexample/model/VoiceServerEvent.kt:155`
  and
  `Android/VoiceApiAndroidExample/app/src/main/java/ai/x/voiceapiandroidexample/connection/VoiceConnection.kt:202`.
- The same commit's iOS app looks for incoming `ping_timestamp`. The live
  service used `timestamp`, matching Android, so the experiment did not infer
  the field name from the inconsistent iOS example.

## Controlled method

Both arms used:

- `grok-voice-think-fast-2.0`;
- a separate 300 s ephemeral client secret minted from Doppler project
  `voice`, config `dev_jonas` (no credential is present in the artifacts);
- the same production-shaped `session.update`: 16 kHz binary PCM input and
  output, manual turn detection, and no audio or response request;
- a hard 45 s observation window, below the requested 90 s-per-arm limit.

The baseline first captured and validated the live timestamp field. The second
arm refused to send a reply unless every live ping carried that same numeric
field, then mapped it to `ping_timestamp` exactly as the official Android
client does.

Command:

```sh
doppler run --project voice --config dev_jonas -- \
  pnpm exec tsx \
  apps/kit/evidence/xai-realtime-idle-ping-ab-2026-07-31/run.mts
```

## Results

| Arm      | Received JSON pings | Sent JSON pongs | Observation            | Close                   |
| -------- | ------------------: | --------------: | ---------------------- | ----------------------- |
| baseline |                   5 |               0 | open through 45,144 ms | client `1000` at cutoff |
| pong     |                   5 |               5 | open through 45,153 ms | client `1000` at cutoff |

The first ping arrived about 0.5 s after opening in both arms. Subsequent ping
intervals were 9,995–10,004 ms. There were no error events, binary frames, or
server close frames in either arm.

Artifact hashes:

- `run.mts`: `f8ff81b25c32d27a70b356496119d71eedd328b5f5c80bdc32b3014f1700cf18`
- `result.json`: `d47a577cc6646fa9fe45353ccf8020b39591225ae88ae332d613da1d4e7c19f4`

## Actionable next step

Treat JSON `pong` support as protocol hygiene, not as the diagnosed close fix.
The next causal experiment belongs at the narrower remaining boundary: run the
same 45 s no-pong/pong A/B from the deployed Workerd outbound WebSocket path,
while retaining socket generation and close-source diagnostics. If only the
Workerd arm fails, investigate its outbound-WebSocket lifetime/ownership and
deployment boundary; if both Workerd arms survive, correlate the reported
close with device-lane replacement rather than attributing it to xAI keepalive.
