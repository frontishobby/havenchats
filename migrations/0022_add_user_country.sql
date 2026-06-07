-- 프로필 국가. NSFW 노출 게이트로 사용: 'PY'(파라과이)만 NSFW 콘텐츠 노출, 'KR'(대한민국)·NULL 은 SFW 만.
ALTER TABLE users ADD COLUMN country TEXT;
