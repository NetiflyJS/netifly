# [@netiflyjs/core-v2.0.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.12.0...@netiflyjs/core-v2.0.0) (2026-10-07)


### Bug Fixes

* address final-review findings (NOT-38) ([52c9726](https://github.com/NetiflyJS/netifly/commit/52c9726c4e1967090a179d9fa1cf39b30afb218d))
* **core:** ack 'invalid' when transport.claim() fails, so an action frame is never left unanswered (NOT-38) ([9aedfb7](https://github.com/NetiflyJS/netifly/commit/9aedfb78e82ed0fe1931431e369c353398595ae0))
* **core:** add null/object guards and protocol-relative URL protection to validateNotification (NOT-37) ([b367049](https://github.com/NetiflyJS/netifly/commit/b367049a067eb2a26e458399b3b6465e2a634f22))
* **core:** address final review findings — link-safety bypass, schema/runtime drift, icon/expiresAt/meta validation, client docs (NOT-37) ([24fc12a](https://github.com/NetiflyJS/netifly/commit/24fc12a0b409ae391ad8057e93fb95e1a814fe9a))
* **core:** clear drain timer after graceful close to avoid leaking it (NOT-19) ([c883157](https://github.com/NetiflyJS/netifly/commit/c883157aebfcc05cd870b3d0532a6291aee30873))
* **core:** eliminate connect-race hazard in netiflyPublisher.test.ts ([730244f](https://github.com/NetiflyJS/netifly/commit/730244f07bee2798513a7147cd9de85197fb3713))
* **core:** reject tampered action tokens with trailing invalid hex in the signature ([8fb7c2f](https://github.com/NetiflyJS/netifly/commit/8fb7c2fb1bba44fbc1be9b595071d543fbfdad71))
* **core:** revert out-of-scope action handling in netiflyServer ([75ca488](https://github.com/NetiflyJS/netifly/commit/75ca4885019b23dd9be67b86290dbe262ffe5a1c))
* **core:** uniquify claim() test keys per run to avoid local Redis TTL re-run collisions (NOT-38) ([bea34a4](https://github.com/NetiflyJS/netifly/commit/bea34a4adc52fd298f904c7ac500adff3619e811))
* **lint:** allow destructure-to-omit pattern in no-unused-vars ([b0889e2](https://github.com/NetiflyJS/netifly/commit/b0889e21bfeddea0d6576dcc0c89d543eb0fcb30))


### Features

* **core:** actionable notifications — verified answers, 'action' event, resolved relay (NOT-38) ([60617cd](https://github.com/NetiflyJS/netifly/commit/60617cd79e2b4e92ad2fe4fd5d9689254bc7669d))
* **core:** add actionSecret resolution for actionable notifications (NOT-38) ([93cd6b9](https://github.com/NetiflyJS/netifly/commit/93cd6b94287cdf2661475c4345a404ced14ea8af))
* **core:** add NetiflyInstance.notify()/notifyOr() (NOT-37) ([7925152](https://github.com/NetiflyJS/netifly/commit/79251525007d95b0b5cd07da94a06481936b0a03))
* **core:** add NetiflyPublisher.notify() (NOT-37) ([708b2bb](https://github.com/NetiflyJS/netifly/commit/708b2bb944dc0ac458a47af6e3420af4b365f572))
* **core:** add NetiflyTransport.claim() — atomic answered-lock primitive for actionable notifications (NOT-38) ([3d32411](https://github.com/NetiflyJS/netifly/commit/3d32411a9bf276d017a7acd16f3e61c43c1a6eeb))
* **core:** add notify() notification schema and validation (NOT-37) ([2a66a4d](https://github.com/NetiflyJS/netifly/commit/2a66a4d580fe7e2599beee89b89c30354a0be07e))
* **core:** add signed action token construction and verification (NOT-38) ([c005a61](https://github.com/NetiflyJS/netifly/commit/c005a61d404f2f7440529e0acf1880a1f6708fd2))
* **core:** export actionable notification types, widen JSON schema, add type tests (NOT-38) ([8540f1a](https://github.com/NetiflyJS/netifly/commit/8540f1af5507ecd2b6171cd7abc65ec2afa85421))
* **core:** export notify() types, JSON schema, and type tests (NOT-37) ([41f387c](https://github.com/NetiflyJS/netifly/commit/41f387c575ca5a43ce9a3bfc454fbb77e050428c))
* **core:** NetiflyPublisher.notify(kind:'action') (NOT-38) ([a9b85ed](https://github.com/NetiflyJS/netifly/commit/a9b85edb62b4e55ab11003b7827a0489574f1e22))
* **core:** parse the inbound 'action' frame (NOT-38) ([61463ac](https://github.com/NetiflyJS/netifly/commit/61463ac431f0aa50a42eedf765175b684e7289f5))
* **core:** widen notify() to kind:'action' with validation (NOT-38) ([eac988f](https://github.com/NetiflyJS/netifly/commit/eac988f87a96e3a3062166dcbdd9e538ea5d4268))


### BREAKING CHANGES

* **core:** createNetifly()/createNetiflyPublisher() now throw at
construction unless actionSecret or NETIFLY_SECRET is set, or
actionSecret: false is passed explicitly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

# [@netiflyjs/core-v1.12.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.11.0...@netiflyjs/core-v1.12.0) (2026-09-29)


### Bug Fixes

* **core:** address final review findings for transport abstraction (NOT-20) ([c2d839c](https://github.com/NetiflyJS/netifly/commit/c2d839cf8ae530d9590820f33f0745496a88d8c9))
* **core:** make memoryTransport() single-process, fix contract suite to match (NOT-20) ([f74fdf8](https://github.com/NetiflyJS/netifly/commit/f74fdf8b8ea4a0ab58b1eb00ca8df3265db6e27e))


### Features

* **core:** add NetiflyTransport interface, contract suite, and memoryTransport() (NOT-20) ([7607192](https://github.com/NetiflyJS/netifly/commit/7607192065f345b1fba7931d35a302450abfb601))
* **core:** add RefCountedTransport, lifting subscribe overlap out of the raw transport (NOT-20) ([a7479a3](https://github.com/NetiflyJS/netifly/commit/a7479a385b1aa4033cafac9a38ce657e28478486))
* **core:** extract redisTransport() from RedisRouter (NOT-20) ([cdd849e](https://github.com/NetiflyJS/netifly/commit/cdd849e84850ce7184bca9e72608793a23121821))
* **core:** wire createNetifly() to the transport abstraction (NOT-20) ([c5f0165](https://github.com/NetiflyJS/netifly/commit/c5f016527f4969aad42e5389f7b4455841d9745f))

# [@netiflyjs/core-v1.11.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.10.1...@netiflyjs/core-v1.11.0) (2026-09-28)


### Bug Fixes

* **core:** isolate throwing/rejecting listeners on new NOT-30 events ([bd4fbb5](https://github.com/NetiflyJS/netifly/commit/bd4fbb53b32a1f36f2c57d96d3c9280aff782e26))
* **core:** satisfy eslint no-explicit-any in wrapListener's inner closure ([e533ccd](https://github.com/NetiflyJS/netifly/commit/e533ccdeb5a4c61859764eda22860c645d022f7a))


### Features

* **core:** add inbound client frame parser for ack/read/response (NOT-30) ([57f0eab](https://github.com/NetiflyJS/netifly/commit/57f0eabb77ed168e78e74f606edb3bca3f8156b9))
* **core:** add per-connection token bucket rate limiter (NOT-30) ([213fc21](https://github.com/NetiflyJS/netifly/commit/213fc21900ef2f7c374faa436c00247dda99e6de))
* **core:** emit 'sent' from NetiflyPublisher.send() (NOT-30) ([f43890a](https://github.com/NetiflyJS/netifly/commit/f43890a68600f2b2cf88f6d4d02c08bbfb271b4c))
* **core:** emit 'sent' from send()/sendOr() for send-time persistence (NOT-30) ([ec718f3](https://github.com/NetiflyJS/netifly/commit/ec718f31593fe1755af138c6dbe697417c8a36bf))
* **core:** emit delivered/read/response/malformedFrame from inbound frames (NOT-30) ([dcbb5cf](https://github.com/NetiflyJS/netifly/commit/dcbb5cf185abd12c6201d1f17b98b84bf5348ba3))
* **core:** rate-limit inbound client frames per connection (NOT-30) ([1474c19](https://github.com/NetiflyJS/netifly/commit/1474c19b8ee60b006bc2ac5fb0cc07a68eabf326))
* **core:** relay ack/read/response to a user's other connections (NOT-30) ([f882909](https://github.com/NetiflyJS/netifly/commit/f882909737dc0681b4f6511e38a9fe7e0a955d6a))

# [@netiflyjs/core-v1.10.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.10.0...@netiflyjs/core-v1.10.1) (2026-09-27)


### Bug Fixes

* **core:** wait for Redis disconnect to actually finish, fixing Jest open-handle warnings ([6f4d1ce](https://github.com/NetiflyJS/netifly/commit/6f4d1ce8c709c6b288762c00c374ed2fbba53598))

# [@netiflyjs/core-v1.10.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.9.0...@netiflyjs/core-v1.10.0) (2026-09-26)


### Features

* **core:** graceful close() draining connections with code 1012 ([d9599ab](https://github.com/NetiflyJS/netifly/commit/d9599aba662f9511fdbbe9ca243e9a906c932d22))

# [@netiflyjs/core-v1.9.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.8.0...@netiflyjs/core-v1.9.0) (2026-09-26)


### Features

* **core:** add typed events via createNetifly<Events>() and a validate hook ([3a28676](https://github.com/NetiflyJS/netifly/commit/3a286764de68e3ea4abcc43302750bd8cf3d2b9a))

# [@netiflyjs/core-v1.8.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.7.0...@netiflyjs/core-v1.8.0) (2026-09-26)


### Features

* **core:** add createNetiflyPublisher() for workers/cron/serverless ([46c3a0a](https://github.com/NetiflyJS/netifly/commit/46c3a0a37bf1231e0aee9c23556b5e9d4270cf14))
* **core:** reject unauthorized upgrades with 401 + reject event ([6f3976c](https://github.com/NetiflyJS/netifly/commit/6f3976c7ad23bcf9488a2cc80f4258826b7b3c7c))

# [@netiflyjs/core-v1.7.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.6.0...@netiflyjs/core-v1.7.0) (2026-09-26)


### Features

* **core:** add namespace option to isolate shared Redis instances ([c22784a](https://github.com/NetiflyJS/netifly/commit/c22784a9ec80e496a7d250ee4aeb0c8a1ba92cfe))

# [@netiflyjs/core-v1.6.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.5.0...@netiflyjs/core-v1.6.0) (2026-09-26)


### Features

* **core:** add presence API (isOnline, whoIsOnline, isConnectedHere) ([d218a8e](https://github.com/NetiflyJS/netifly/commit/d218a8e883b75d81da806e60e930c6e8ca2142cb)), closes [RedisRouter#numSubscribers](https://github.com/RedisRouter/issues/numSubscribers) [NetiflyInstance#isOnline](https://github.com/NetiflyInstance/issues/isOnline)
* **core:** delivery-aware send() returning { delivered, instances }, plus sendOr() ([6db1907](https://github.com/NetiflyJS/netifly/commit/6db190707edc2d80a28deeb79d9e37ab3b5455c0)), closes [RedisRouter#publish](https://github.com/RedisRouter/issues/publish)

# [@netiflyjs/core-v1.5.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.4.0...@netiflyjs/core-v1.5.0) (2026-09-26)


### Features

* **core:** bound inbound frame size, outbound buffers, and connections per user ([1669886](https://github.com/NetiflyJS/netifly/commit/16698862d22da18165a02182faa05b0d15e705fa))

# [@netiflyjs/core-v1.4.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.3.1...@netiflyjs/core-v1.4.0) (2026-09-25)


### Features

* **core:** add Origin allowlist to prevent cross-site WebSocket hijacking ([0791ed5](https://github.com/NetiflyJS/netifly/commit/0791ed59d4fab99f29b5086d88c00b24f9d6b72f))

# [@netiflyjs/core-v1.3.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.3.0...@netiflyjs/core-v1.3.1) (2026-09-25)


### Bug Fixes

* **core:** ref-count Redis subscriptions to close subscribe/unsubscribe race ([23a860f](https://github.com/NetiflyJS/netifly/commit/23a860f83f3025ca82b9c974dac635f887b4e882))

# [@netiflyjs/core-v1.3.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.2.0...@netiflyjs/core-v1.3.0) (2026-09-25)


### Features

* add message envelop ([eed4a1b](https://github.com/NetiflyJS/netifly/commit/eed4a1bfe6ff314f52b8916170666940e509d9cd))

# [@netiflyjs/core-v1.2.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.1.0...@netiflyjs/core-v1.2.0) (2026-09-25)


### Features

* rename Notifly to Netifly across public API and docs ([7c7473d](https://github.com/NetiflyJS/netifly/commit/7c7473dc5bf3769acc6e795653fe027b7c6a28e0))

# [@netiflyjs/core-v1.1.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.1...@netiflyjs/core-v1.1.0) (2026-09-25)


### Features

* updated docs and license ([bb80f69](https://github.com/NetiflyJS/netifly/commit/bb80f69e24f78dd6fc538cf42096854de33c9de6))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-25)


### Bug Fixes

* use absolute logo URL and add repository field to packages ([371aec3](https://github.com/NetiflyJS/netifly/commit/371aec369b74287cddbb49ac47a661a151bab8ee))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-25)


### Bug Fixes

* use absolute logo URL and add repository field to packages ([371aec3](https://github.com/NetiflyJS/netifly/commit/371aec369b74287cddbb49ac47a661a151bab8ee))

# @netiflyjs/core-v1.0.0 (2026-09-25)


### Bug Fixes

* address final review findings and rename npm scope to [@notiflyjs](https://github.com/notiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))
* **ci:** migrate npm publish to OIDC trusted publishing ([85b8f39](https://github.com/NetiflyJS/netifly/commit/85b8f3945cb3d0c0f6ccf63b0bc2d5f7463a81a4))
* rename npm scope and GitHub org from notiflyjs to netiflyjs ([48885f3](https://github.com/NetiflyJS/netifly/commit/48885f3a3828f6727b664cc5b9b0b79acb8896d0))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-24)


### Bug Fixes

* **ci:** migrate npm publish to OIDC trusted publishing ([85b8f39](https://github.com/NetiflyJS/netifly/commit/85b8f3945cb3d0c0f6ccf63b0bc2d5f7463a81a4))

# @netiflyjs/core-v1.0.0 (2026-09-24)


### Bug Fixes

* address final review findings and rename npm scope to [@netiflyjs](https://github.com/netiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))

# @netiflyjs/core-v1.0.0 (2026-09-24)


### Bug Fixes

* address final review findings and rename npm scope to [@netiflyjs](https://github.com/netiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))
