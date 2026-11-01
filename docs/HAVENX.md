# .havenx — Haven 캐릭터 패키지 포맷 (v1)

charx 가 RisuAI 카드를 담듯, `.havenx` 는 Haven 캐릭터 하나를 **에셋까지 파일 하나로** 담는다.
구현: `src/lib/local/havenx.ts`(내보내기·검증·가져오기), UI: 캐릭터 상세 모달 'havenx 내보내기' / `/havenx`(가져오기, 여러 파일 동시).

## 컨테이너

zip. 엔트리:

```
manifest.json          ← 첫 엔트리 권장(가져오기가 이미지를 버퍼링 없이 바로 저장). 뒤에 와도 동작한다.
assets/thumbnail.webp  ← 카드 썸네일(1024²)
assets/full.webp       ← 상세 이미지(2048², 선택)
assets/scenes/<id>.webp
assets/style.webp      ← 추천 그림체 썸네일(선택)
assets/sessions/<n>/<seq>.webp  ← 대화 속 생성 이미지(선택)
```

경로는 자유 — manifest 가 가리키는 경로만 읽는다. 이미지 확장자: webp·avif·png·jpg(jpeg)·gif. 이미지는 무압축(STORED) 권장.

## manifest.json

```jsonc
{
  "format": "havenx",
  "version": 1,
  "exportedAt": 1793541485025,      // epoch ms
  "generator": "havenchats.com",    // 자유 문자열
  "character": {
    "name": "이레",                  // 필수
    "tagline": "한 줄 소개",
    "intro": "상세 모달 소개글(프롬프트 미포함)",
    "description": "시스템 프롬프트 본문",
    "audience": "all",              // all | male | female
    "contentRating": "sfw",         // sfw | nsfw
    "tags": ["미스터리"],
    "greetings": [{ "name": "오프닝 이름", "content": "본문" }],   // 문자열 배열도 허용
    "lorebook": { "entries": [{ "id": "…", "keys": ["안개"], "content": "…", "constant": false, "order": 10 }] },
    "scriptData": null,             // { defaultVariables: {…} } — charx 유래
    "displayScripts": null,         // [{ in, out, flags }] — charx 유래
    "imported": false,              // true = charx 유래(프롬프트 숨김·수정 불가)
    "thumbnail": "assets/thumbnail.webp",  // 없으면 null → 기본 아바타
    "fullImage": null,
    "scenes": {                     // null | grid | named
      "kind": "grid",
      "axes": [{ "label": "장소", "values": ["사무실", "회식"] }, { "label": "표정", "values": ["업무", "당황"], "fallback": 0 }],
      "entries": [{ "id": "bel-office-work", "combo": [0, 0], "file": "assets/scenes/bel-office-work.webp" }]
    }
    // named: { "kind": "named", "images": [{ "id": "cvs-rules", "name": "근무 수칙", "file": "…" }] }
  },
  "style": {                        // 추천 그림체(선택). id 는 유지 — 같은 id 가 이미 있으면 재사용
    "id": "…", "title": "…", "memo": null, "prompt": "watercolor, …",
    "model": "nai-diffusion-5-full", "negative": null, "quality": null, "thumbnail": "assets/style.webp"
  },
  "sessions": [                     // 대화 기록(선택)
    {
      "model": "deepseek/…", "summary": null, "summaryUptoSeq": 0, "memory": null,
      "scriptState": null, "appearances": null, "outfits": null,
      "createdAt": 0, "updatedAt": 0, "lastMessageAt": 0,
      "messages": [
        { "seq": 1, "role": "assistant", "content": "…", "createdAt": 0 },
        { "seq": 4, "role": "image_generation", "content": "", "image": "assets/sessions/1/4.webp", "createdAt": 0 }
        // 선택: inputTokens, cost, model, targetSentences
      ]
    }
  ]
}
```

## 가져오기 규칙

- **항상 새 캐릭터·새 세션·새 메시지 id**(같은 파일을 두 번 가져오면 사본 2개). 캐릭터는 `visibility='private'`.
- 장면 엔트리 `id` 는 유지(`[A-Za-z0-9_-]{1,80}`, 아니면 새로 발급) → 메시지·오프닝의 고정 토큰 `{#id}` 가 그대로 맞는다. 오프닝에 `{#id}`·`<img="이름">` 을 넣어 첫 장면 이미지를 지정할 수 있다.
- 이미지 키: `char/<새id>.<ext>`, `charfull/…`, `charimg/<새id>/<엔트리id>.<ext>`, `style/<스타일id>.<ext>`, `chatimg/<새세션id>/<새메시지id>.<ext>`. 같은 zip 파일을 여러 키가 가리켜도 된다(썸네일을 장면으로 재사용 등).
- zip 에 실제로 없는 이미지를 가리키는 장면 엔트리·생성 이미지 메시지는 빠진다(깨진 참조 방지). 검증은 관대 — 누락 필드는 기본값, grid combo 가 축 범위를 벗어나면 그 엔트리만 버림.
- DB 쓰기는 batch 한 번(트랜잭션). 실패 시 저장한 이미지를 지운다. OneDrive 모드면 R2 shim put·DB 쓰기 훅으로 자동 동기화 대기열에 오른다.

## 내보내기 규칙

- 원본 행을 그대로 읽는다(imported 캐릭터의 숨김 프롬프트·로어북 포함 — 1인 모드라 본인 데이터).
- charx 직후의 `storage:'local'` 장면(`haven-local-scenes` IndexedDB)도 읽어 담는다 → 가져오면 일반 R2 키가 되어 동기화된다.
- 로컬에 없는 이미지는 R2 shim 의 miss 핸들러로 OneDrive 에서 받아 담고, 그래도 없으면 건너뛰고 개수를 알려 준다.
- 저장은 `openSaveSink`(backup.ts) — File System Access 가 있으면 디스크로 스트리밍, 없으면 Blob 다운로드.
