# 모의주식 투자 성적표 프로그램

모둠별 모의주식 투자 장부를 관리하고 투자 성적표를 출력/PDF로 저장하는 React 기반 웹 프로그램입니다.

## 주요 기능

- 관리자/투자자 로그인 분리
- 모둠별 초기 투자 원금 500만원 적용
- 라운드별 분산 투자 장부 입력
- 종목별 주당 가격과 라운드별 변동률 설정
- 라운드 추가/삭제 및 다음 라운드 진행
- 모둠별 투자 성적표, 순위 그래프, PDF 저장/출력
- 공유용 단일 HTML 생성

## 실행

```bash
npm install
npm run dev
```

## 공유용 HTML 생성

```bash
npm run build:share
```

생성 파일:

```text
share/모의주식_투자성적표_프로그램.html
```

## 기본 로그인

- 관리자 비밀번호: `admin1234`
- 투자자 입장코드: `1모둠 0001`, `2모둠 0002`, `3모둠 0003` 방식

## Supabase 공용 장부 연결

서로 다른 PC에서 같은 투자 장부를 보려면 Supabase 프로젝트가 필요합니다.

1. Supabase에서 새 프로젝트를 만듭니다.
2. SQL Editor에서 `supabase/schema.sql` 내용을 실행합니다.
3. Project Settings > API에서 아래 값을 확인합니다.
   - Project URL
   - anon public key
4. 로컬 실행 시 `.env.local`에 입력합니다.

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

5. Vercel 배포 시 같은 환경변수를 Project Settings > Environment Variables에 추가합니다.

Supabase 환경변수가 없으면 기존처럼 각 브라우저의 로컬 저장소에만 저장됩니다.
