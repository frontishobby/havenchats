# Haven ↔ Claude Code 구독 브릿지

`Opus 4.6 Subscription` 모델의 백엔드. 내 머신(homebox)에서 Claude Code CLI(`claude -p`, 구독 OAuth)를
서브프로세스로 띄워 OpenAI 호환 `/v1/chat/completions`(SSE) 로 노출한다. Haven 은 `@ai-sdk/openai-compatible` 로 붙는다.

## homebox 설치(1회)

```bash
# 사전: claude 설치·로그인(claude auth status → loggedIn), node 22, tailscale
scp bridge/haven-bridge.mjs bridge/haven-bridge.service homebox:~/haven-bridge/
ssh homebox 'mkdir -p ~/.config/systemd/user && cp ~/haven-bridge/haven-bridge.service ~/.config/systemd/user/ \
  && systemctl --user daemon-reload && systemctl --user enable --now haven-bridge && sudo loginctl enable-linger $USER'
ssh homebox 'systemctl --user status haven-bridge; curl -s localhost:8787/health'
# 테일넷 https 노출(관리 콘솔에서 Serve/HTTPS 를 켠 뒤)
ssh homebox 'tailscale serve --bg --https=443 http://127.0.0.1:8787'   # → https://bridge.example.ts.net
```

갱신: `scp bridge/haven-bridge.mjs homebox:~/haven-bridge/ && ssh homebox systemctl --user restart haven-bridge`
로그: `ssh homebox journalctl --user -u haven-bridge -f` (턴마다 `resume|new`, 토큰, 캐시, 5시간 사용량 %)

## Haven 쪽

프로필 › API 키 관리 › **Claude 구독 브릿지** 에 주소 등록(`https://bridge.example.ts.net`, 로컬 개발은
`ssh -f -N -L 8787:127.0.0.1:8787 homebox` 뒤 `http://localhost:8787`). 등록 시 `/v1/models` 로 연결을 확인한다.
브릿지 모델을 고르면 Gateway 키 없이도 채팅·요약·입력 필터가 브릿지로 간다. 비용은 0(구독 한도 차감).

## 동작

- `claude -p --model <id> --system-prompt-file … --setting-sources "" --strict-mcp-config --disable-slash-commands
  --tools "" --max-turns 1 --output-format stream-json --include-partial-messages` + `MAX_THINKING_TOKENS=0`.
  설정·MCP·스킬을 끄면 기본 오버헤드가 60k → 300 토큰으로 줄고, `--bare` 는 OAuth 를 안 읽어 구독으론 못 쓴다.
- 세션: 요청 헤더 `x-haven-session`(Haven 세션 id) 별로 `{cliSid, count, lastAssistant}` 를 `sessions.json` 에 기억.
  직전 턴 대비 (assistant 응답 + 새 user) 한 쌍만 늘어난 깨끗한 추가면 `--resume` 으로 마지막 메시지만 보내
  프롬프트 캐시가 그대로 먹는다(실측: 2턴째 cache_read 9,154 / creation 68). 재생성·삭제·편집·요약 이동·이어가기
  병합은 새 CLI 세션 + 전체 이력 대본(그 턴만 미스). resume 이 `No conversation found` 면 자동으로 새 세션.
- 캐시 최소 길이: Opus 4.6 은 4,096 토큰 미만 프롬프트는 캐시되지 않는다(짧은 테스트에서 cached 0 은 정상).
- 인증: 테일넷 전용이라 기본 없음. `BRIDGE_TOKEN` 환경변수를 주면 `Authorization: Bearer` 검사.
