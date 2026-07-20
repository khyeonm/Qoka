# Installer WSL Finish-Page Flow (제안 — 추후 구현 검토용)

**상태:** 제안(Proposal). 아직 미구현. 이 문서는 나중에 구현을 검토하기 위한 정리본이다.

**대상 파일:**
- 설치 관리자: [`build/win32/code.iss`](build/win32/code.iss)
- 런타임: [`extensions/aria-autopipe/src/vm/vmManager.ts`](extensions/aria-autopipe/src/vm/vmManager.ts) (`startWsl`), [`extensions/aria-autopipe/src/vm/wsl.ts`](extensions/aria-autopipe/src/vm/wsl.ts)

---

## 1. 배경 — 현재 동작

Inno Setup finish 페이지의 `[Run]` 섹션([code.iss:108](build/win32/code.iss#L108)):

| 항목 | 조건 | 비고 |
|---|---|---|
| WSL 설치 체크박스 | `Check: WslNotInstalled` | `wsl --install -d Ubuntu`를 관리자 권한(UAC)으로 실행. WSL 없을 때만 표시 |
| Launch Qoka (업데이트) | `Check: ShouldRunAfterUpdate` | 업데이트 시나리오 |
| Launch Qoka (일반) | `Check: WizardNotSilent` | 일반 설치 시 항상 표시 |

- `WslNotInstalled`([code.iss:1316](build/win32/code.iss#L1316))은 `wsl.exe --status`를 실행해 실패/비-0이면 "WSL 없음"으로 판정.
- WSL 설치 항목의 Flags: `postinstall waituntilterminated runhidden skipifsilent`.

**문제:** WSL이 없을 때 **WSL 설치 체크박스와 Launch Qoka 체크박스가 동시에** 뜬다. WSL 설치+재부팅이 필요한 상황에서 Qoka를 바로 켜도 built-in server가 동작하지 않으므로 무의미하다.

---

## 2. 목표 동작 (finish 페이지)

| 상황 | 표시할 체크박스 |
|---|---|
| **WSL 없음** (`WslNotInstalled`) | ☑ "Install WSL (Ubuntu)…" **만** 표시. Launch Qoka는 **숨김** |
| **WSL 있음** | Launch Qoka만 (기존대로) |

추가로, WSL을 설치하는 사용자가 재부팅 이후 흐름(계정 생성 → Qoka 실행)을 알 수 있도록 **명시적 안내 메시지**를 띄운다.

---

## 3. 전체 흐름 (WSL 없는 새 사용자)

```
1. Qoka installer 진행
2. Finish 페이지 → ☑ "Install WSL (Ubuntu)…" 하나만 표시 (기본 체크)
3. [Finish] 클릭
   → PowerShell이 관리자 권한(UAC)으로 `wsl --install -d Ubuntu` 실행
   → (제안) 안내 MsgBox 표시: "재부팅 → Ubuntu 계정 생성 → Qoka 실행"
4. 사용자가 재부팅
5. 재부팅 후:
   - WSL은 자동 실행되지 않음 (on-demand)
   - Windows가 Ubuntu 콘솔을 한 번 자동으로 열어 UNIX 계정(사용자명/비번) 생성 요청
     (wsl --install이 설정한 RunOnce; Win11/최신 Win10에서 대체로 자동, 아니면 시작메뉴 "Ubuntu" 수동 실행)
   - Qoka는 자동 실행되지 않음
6. 사용자가 Qoka를 직접 실행
   → 런타임(VMManager.startWsl)이 wsl을 호출해 distro 기동
   → 프로비저닝(docker/sshd/uv) → built-in server 준비 완료
```

---

## 4. 재부팅 / 자동 실행 동작 정리 (Q&A)

**Q. 재부팅 후 WSL이 자동으로 켜지나?**
아니오. WSL은 상주 실행이 아니라 **on-demand**다. `wsl.exe`나 distro가 호출될 때만 경량 VM이 올라온다.

**Q. 재부팅 후 계정 생성 창은 뜨나?**
대체로 예. `wsl --install`이 건 RunOnce로 Ubuntu 콘솔이 자동으로 한 번 열려 계정 생성을 요청한다.
- Win11 / 최신 Win10: 대체로 자동.
- 일부 구버전/설정: 자동으로 안 뜰 수 있음 → 시작메뉴에서 "Ubuntu" 1회 실행하면 계정 생성 시작.
- 런타임도 "계정 미생성 / user=root" 케이스를 감지해 터미널을 열고 안내함.

**Q. 계정 생성 후 "Qoka를 실행하라"는 안내가 뜨나?**
현재는 **아니오 (갭).** 계정 생성 창은 Canonical(Ubuntu)의 화면이라 Qoka를 모른다. Launch 체크박스도 숨기므로 Qoka가 자동 실행되지 않는다 → 사용자를 Qoka로 다시 유도하는 흐름이 끊긴다. 이를 **방법 A(안내 메시지)**로 보완한다.

---

## 5. 구현 상세

### 5-1. Launch Qoka 체크박스 숨김 (WSL 없을 때)

[code.iss](build/win32/code.iss#L120)의 일반 Launch 줄 `Check`를 "WSL 설치돼 있고 무인 아님"으로 변경:

```
; Launch Qoka - WSL이 있을 때만 표시 (WslNotInstalled면 숨김)
Filename: "{app}\{#ExeBasename}.exe"; Description: "{cm:LaunchProgram,{#NameLong}}"; Flags: nowait postinstall; Check: WslInstalledAndNotSilent
```

`[Code]`에 헬퍼 추가:
```pascal
function WslInstalledAndNotSilent(): Boolean;
begin
  Result := (not WslNotInstalled()) and (not WizardSilent());
end;
```

> 참고: `WslNotInstalled()`는 매번 `wsl --status`를 Exec하므로 finish 페이지에서 2회 호출된다(WSL 체크박스 + Launch 체크). 비용이 신경 쓰이면 결과를 전역 변수에 1회 캐시.

### 5-2. 안내 메시지 (방법 A, 권장)

WSL 설치 실행 직후 재부팅 이후 단계를 알리는 MsgBox. 구현 방식 후보:
- WSL 설치 `[Run]` 항목에 `AfterInstall:` 프로시저를 붙여 그 안에서 `MsgBox(...)`, 또는
- `CurStepChanged(ssPostInstall)`에서 `WslNotInstalled()`가 참일 때만 MsgBox.

메시지 예:
```
"WSL(Ubuntu)을 설치 중입니다.

1) PC를 재부팅하세요.
2) 재부팅 후 열리는 Ubuntu 창에서 사용자명과 비밀번호를 만드세요.
3) 그다음 Qoka를 실행하면 준비가 완료됩니다."
```

### 5-3. (선택) 재부팅 후 Qoka 자동 실행 (방법 B)

`RunOnce` 레지스트리로 다음 로그인 시 Qoka 자동 실행.
- 장점: 사용자가 Qoka로 자동 복귀.
- 단점: **계정 생성 전에 Qoka가 먼저 뜰 수 있음** → 그 경우 런타임이 "계정 만들라"고 안내는 하지만 순서가 어색. 방법 A와 병행 시 보완됨.
- 구현: `[Registry]`에 `Root: HKCU; Subkey: "...\RunOnce"; ValueName: "QokaFirstRun"; ValueData: "...\Code.exe"; Check: WslNotInstalled` 형태.

### 5-4. (선택) 재부팅 프롬프트 강화

현재는 체크박스 설명의 "(needs a reboot)"로만 안내. Inno의 재부팅 프롬프트/`Flags: restart`로 더 강하게 유도 가능(과할 수 있으니 선택).

---

## 6. 관련 미해결 항목 — Docker 설치 폴백

이 흐름과 별개로, 프로비저닝의 docker 설치에 **잔재 충돌 대비 폴백이 아직 없다**.

[wsl.ts:153](extensions/aria-autopipe/src/vm/wsl.ts#L153) 현재:
```sh
if ! command -v docker >/dev/null 2>&1; then apt_update_once; apt-get install -y docker.io; fi
```
- **깨끗한 Ubuntu**(installer가 새로 만든 distro): 정상 설치. ✅
- **docker-ce/containerd.io 잔재가 있는 머신**: `pkgProblemResolver::Resolve generated breaks` 오류 재발. ❌

권장 수정(비파괴적):
```sh
if ! command -v docker >/dev/null 2>&1; then
  apt_update_once
  apt-get install -y docker.io || apt-get install -y docker-ce docker-ce-cli containerd.io
fi
```

---

## 7. 결정 필요 항목

- [ ] 5-1 (Launch 체크박스 숨김) 적용 여부
- [ ] 5-2 안내 MsgBox 적용 여부 (권장: 적용)
- [ ] 5-3 RunOnce 자동 실행 적용 여부 (선택)
- [ ] 5-4 재부팅 프롬프트 강화 여부 (선택)
- [ ] 6. Docker 폴백 적용 여부 (권장: 적용)
