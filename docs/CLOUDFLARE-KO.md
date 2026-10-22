# Cloudflare 무료 요금제 운영 (2026-10-22~)

ChatGPT 유료 구독이 끝난 뒤에는 본인 Cloudflare 계정의 무료 Workers로 운영합니다.

- 주소: https://moungsoo-reference.daily-safety.workers.dev
- Worker 이름: `moungsoo-reference`
- 저장소: Workers KV `moungsoo-reference` (바인딩 `KV`). R2는 카드 등록이 필요해서 쓰지 않습니다.
- 관리자 로그인: `?page=admin`에서 토큰으로 로그인합니다. 토큰 값은 이 PC의 `.env.cloudflare`에 있고 Git에는 올라가지 않습니다. ChatGPT 계정 로그인은 이 주소에서 쓰지 않습니다.

## 배포

```
npm run deploy:cloudflare
```

이 명령은 `npm run build` 후 `cloudflare/wrangler.toml`로 배포합니다. 이 PC는 Cloudflare에 로그인되어 있습니다(`npx wrangler whoami`로 확인). 관리자 토큰을 바꾸려면 `npx wrangler secret put ADMIN_TOKEN --config cloudflare/wrangler.toml`을 실행합니다.

## 무료 요금제에서 확인한 한계 (2026-10-22 측정)

무료 Workers는 요청당 CPU 10ms, KV는 하루 쓰기 1,000회와 값 하나당 25MB로 제한됩니다. 이 앱은 검색할 때마다 저장된 자료 전체를 읽습니다.

| 공개 자료 | 크기 | 요청 18회 결과 | 응답 시간 |
| --- | --- | --- | --- |
| 기본 자료(92건, 법령 전문 8종) | 약 4.3MB | 18/18 성공 | 0.2~1.2초 |
| 기본 + 판례 약 4,800건 | 6.7MB | 17/18 성공 (1회 1102 한도 초과) | 0.2~1.0초 |
| 기본 + 판례 + 법령 전문 32종 | 23MB | 10/12 성공 (1102·1042 오류) | 1~3초 |

측정은 임시 Worker와 임시 KV로 했고, 측정 후 둘 다 삭제했습니다.

정리하면, 무료 요금제에서는 **기본 자료는 안정적이고, 판례를 더하면 가끔 실패하며, 법령 전문 32종까지 넣으면 자주 실패**합니다. 전부 넣으려면 아래 중 하나를 고르세요.

- Workers 유료 요금제(월 약 $5, CPU 한도 상향)
- 법령·판례 전체 자료는 내 PC(`npm run dev`)에서만 보고, 인터넷 주소에는 기본 자료만 두기

## 법제처 자료

Cloudflare 서버 IP도 법제처 OC에 등록되어 있지 않습니다. 그래서 내 PC에서 `npm run collect:laws` / `npm run collect:cases`로 파일을 만든 뒤, 관리자 화면의 "파일 올리기"로 검토 대기에 넣습니다. 평일 9시 자동 갱신 예약은 Cloudflare에 설정되어 있지 않습니다(ChatGPT 예약 작업은 이전되지 않음).
