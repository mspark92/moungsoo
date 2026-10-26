# 운영 현황과 운영자 할 일

기준: 2026-10-26. 법제처 OC는 서버 IP 별도 등록 없이 정상 호출됩니다(운영자 확인). 이전(ChatGPT Sites → Cloudflare → 오라클) 과정의 상세 기록은 [ORACLE-KO.md](./ORACLE-KO.md), [CLOUDFLARE-KO.md](./CLOUDFLARE-KO.md)에 있습니다. 키 값은 채팅·GitHub·스크린샷에 올리지 마세요.

## 지금 운영 중인 사이트

| 구분 | 내용 |
| --- | --- |
| 주소 | https://161-33-13-1.sslip.io (관리자: `?page=admin`) |
| 서버 | 오라클 클라우드 상시 무료 VM.Standard.E2.1.Micro, 오사카 지역, 공용 IP 161.33.13.1 |
| 관리자 토큰 | 서버 `/etc/moungsoo/env`, 이 PC의 `moungsoo\repo\.env.oracle` |
| 서버 접속 키 | 이 PC의 `%USERPROFILE%\.ssh\moungsoo-oracle.key` (사용자 `ubuntu`) |
| 법제처 OC | 서버 `/etc/moungsoo/env`의 `LAW_API_OC` (값은 이 문서에 적지 않음) |
| 자동 갱신 | 평일 09:00(한국시간). 법령 16종씩 번갈아 확인, 최근 30일 판례·결정례·해석례 수집, 국세청 안내 링크 확인 |
| 예비 사이트 | https://moungsoo-reference.daily-safety.workers.dev (Cloudflare 무료, 판례 3,000건·법령 8종, 자동 갱신 없음) |

## 공개 자료 (13,935건)

- 법령: 국세 6법·지방세 4법과 각 시행령·시행규칙, 하도급법·시행령 = 32종 전문
- 판례: 5,179건 (국세법령정보시스템 4,970건은 제목·링크, 대법원 출처 185건은 판결문)
- 조세심판원 결정례: 6,673건 (최근 2년, 재결요지·주문·관련법령. 이유는 공식 원문)
- 국세청 해석례: 1,854건 (최근 2년, 제목·안건번호·공식 링크)
- 공정위 하도급 의결서: 134건 (최근 2년, 결정요지·주문·이유 앞부분)
- 국세청 신고 안내: 25건 (공식 링크, 매일 링크 확인. 공공누리 표시가 없어 본문 미수록)

## 운영자 할 일

| 할 일 | 필요 | 방법 |
| --- | --- | --- |
| 새 자료 공개 | 가끔 | 관리자 화면 → 판례 수집 → 판례 검토 대기에서 확인 후 공개. 평일 갱신이 새 자료를 쌓아 둡니다. |
| 공휴일 제외 키 | 선택 | data.go.kr "한국천문연구원_특일 정보" 활용신청 → 일반 인증키(Decoding)를 서버 `/etc/moungsoo/env`의 `HOLIDAY_API_KEY`에 넣고 `sudo systemctl restart moungsoo`. |
| 국세청 안내 본문 | 선택 | 국세청 저작권정책에 따라 이용 허락을 받으면 본문 수록 가능. |

## 자주 쓰는 명령 (서버)

```
cd /opt/moungsoo && sudo git pull && sudo systemctl restart moungsoo   # 앱 갱신
systemctl status moungsoo                                             # 앱 상태
systemctl list-timers moungsoo-update.timer                           # 다음 자동 갱신 시각
sudo journalctl -u moungsoo-update -n 20                              # 최근 갱신 결과
```

자료는 `/var/lib/moungsoo`에 저장됩니다. 2026-10-26 결정례 공개 직전 상태는 `/var/lib/moungsoo/backup-state-before-decisions.json`에 백업했습니다.

## 내 PC에서 쓰기

`moungsoo\repo` 폴더에서 `npm run dev` 실행 후 http://127.0.0.1:3000 을 엽니다. 로그인 토큰은 `.env`에 있습니다. 내 PC에서 공개한 자료는 운영 사이트와 별개입니다. `npm run collect:laws` / `npm run collect:cases`는 서버 IP가 법제처에서 막혔을 때 쓰는 예비 수집 방법입니다.
