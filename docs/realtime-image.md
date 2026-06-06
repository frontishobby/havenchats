새로운 실시간 이미지 생성 기능 추가할거임. (novelAI 사용)
- 먼저 프로필 누르면 나오는 드롭다운에 API key 관리 버튼 추가하고 누르면 모달 뜨면서 novelAI key 등록가능하도록 설정 (opus 구독 검증 후 서버에 user_keys 테이블에 양방향 암호화 적용하여 저장)
- 채팅 세션에서 설정 버튼 옆에 이미지 버튼 만들고, 누르면 실시간 이미지 생성이 활성화됨
- 활성화 된 경우 해상도(832x1216, 1024x1024) 중 선택 가능하며, 그 아래에 항상 적용될 그림체 프롬프트 입력 가능
- 활성화 이후 채팅 진행시 assistant 출력 이후 따로 gemini 3.5 flash LLM 호출하여 상황 프롬프트를 작성
- 그리고 내가 아래에 작성할 퀄리티 프롬프트까지 해서 novelAI 에다가 그림체 프롬프트 + 상황 프롬프트 + 퀄리티 프롬프트 순으로 합쳐서 전달 (webp 로 생성)
- 생성된 이미지 받아서 webp 로 저장하고 이미지 채팅세션에 노출 (role=image_generation 으로 chat_message 저장. 이후 채팅진행할때는 이거는 LLM 에 보내는 프롬프트에서 제외)
- 이때 프롬프트 만들때 쓴 Gemini 로 인한 cost 는 다른 채팅처럼 X 좌측에 표시

이하는 novelAI 에 고정값으로 전달할 프롬프트 + 파라미터

{그림체 프롬프트}
지정 안할시 기본값=2::1girl, rating:nsfw 1.4::artist:sasamori tomoe:: 1.2::artist:ahemaru::, 0.7::artist:hero_neisan, artist:takano suzu::, 0.4::artist:kidmo::, 1.3::seoyong, artist:sohn woohyoung::, 1.2::healthyman ::, freng, 1.2::artist:sos adult::, 1.2::hiramedousa ::, 1.5::artist:shinjiro, artist:umezawa_itte::, 

{상황 프롬프트}

, -4::artist collaboration, year 2025, year 2024, -3::spoken bubble, text, cross-section::, rating:explicit, {{{-3::censored, photo inset, stomach deformation}}}, {{{-3::small lines::}}}, 1.5::balanced contrast::, -2::simple illustration::, -1::censored::, best quality, amazing quality, very aesthetic, intricate detail, highres, incredibly absurdres

아래는 네거티브 프롬프트 (고정)
text, logo, signature, watermark, too many watermarks, chili inset, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes, multiple views, negative space, blank page, variant set, large variant set, 4koma, 2koma, oekaki, halftone, screentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors, lowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete, ai-generated

아래는 기타 필요 파라미터 (고정)
Model NAID 4.5F
Sampler k_euler_ancestral
Scheduler karras
Steps 28
CFG scale 5.8
CFG rescale 0.28


구현중 애매하면 질의