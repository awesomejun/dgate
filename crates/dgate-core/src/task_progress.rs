//! 마크다운 체크박스 태스크 진행률 — 읽기전용 파서.
//!
//! 목적: 대시보드 Lead 카드에 보여줄 실제 진행률을 레포의 마크다운
//! (`TODO.md` 등)에서 계산한다. 완전 읽기전용이며 파일을 만들거나 쓰지
//! 않는다. 64KiB 읽기 상한 + 최대 32개 파일 스캔 상한으로 비용을 막는다.
//!
//! 외부 연결: `dgate-gui` `poll_once`가 매 폴링 틱마다 호출(UI 스레드 아님).
//!
//! 주의: 코드 펜스(``` · ~~~) 안의 체크박스는 절대 세지 않는다 — 코드
//! 예시가 진행률을 오염시키는 것을 막는다.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 단일 레포의 태스크 진행률 — 어느 파일에서 왔는지까지 보존.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskProgress {
    pub source_name: String,
    pub done: usize,
    pub total: usize,
    pub pct: u8,
}

/// 읽기전용 파일 읽기 상한(바이트) — 대용량 마크다운의 전부를 읽지 않는다.
const MAX_READ_BYTES: usize = 64 * 1024;
/// 하위 디렉터리 1개당 스캔 최대 파일 수.
const MAX_FILES_PER_DIR: usize = 32;

/// 마크다운 체크박스 줄을 세서 (done, total)을 반환.
///
/// 체크박스 줄 = 선택적 들여쓰기 + (`-`|`*`|`+`) + 공백 + `[` + (`x`|`X`|` `) + `]`.
/// 삼중 백틱/틸드 펜스 내부 줄은 무시한다(펜스 마커 자체도 무시).
pub fn parse_markdown_checkboxes(content: &str) -> (usize, usize) {
    let mut done = 0;
    let mut total = 0;
    let mut fence: Option<&str> = None;
    for line in content.lines() {
        let t = line.trim_start();
        if let Some(f) = fence {
            // 펜스 안: 닫는 마커(동일 문자 3개 시작)만 펜스를 끝낸다.
            if t.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if t.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if t.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        let rest = t
            .strip_prefix('-')
            .or_else(|| t.strip_prefix('*'))
            .or_else(|| t.strip_prefix('+'))
            // 불릿 뒤에는 공백이 최소 1개 필요하다("-[x]"는 체크박스가 아니다).
            .filter(|r| r.starts_with(' ') || r.starts_with('\t'))
            .map(str::trim_start);
        if let Some(rest) = rest {
            let b = rest.as_bytes();
            if b.len() >= 3
                && b[0] == b'['
                && b[2] == b']'
                && matches!(b[1], b'x' | b'X' | b' ')
            {
                total += 1;
                if b[1] != b' ' {
                    done += 1;
                }
            }
        }
    }
    (done, total)
}

/// 루트 후보 파일 — 이 순서(우선순위)대로 확인한다.
const ROOT_CANDIDATES: [&str; 6] = [
    "TODO.md",
    "todo.md",
    "TASKS.md",
    "PLAN.md",
    "plan.md",
    ".herdr/plan.md",
];
/// 하위 디렉터리 후보 — 각각 안의 `.md` 파일을 mtime 내림차순으로 확인.
const SUBDIR_CANDIDATES: [&str; 2] = [".todo-flow", "todo"];

/// `path` 파일을 읽기전용으로 열어 최대 64KiB까지만 읽고 진행률을 계산.
/// 체크박스가 하나도 없으면(total == 0) None.
fn progress_from_file(path: &Path, source_name: &str) -> Option<TaskProgress> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_READ_BYTES];
    let mut n = 0usize;
    loop {
        let read = file.read(&mut buf[n..]).ok()?;
        if read == 0 {
            break;
        }
        n += read;
        if n == MAX_READ_BYTES {
            break;
        }
    }
    buf.truncate(n);
    let content = String::from_utf8_lossy(&buf);
    let (done, total) = parse_markdown_checkboxes(&content);
    if total == 0 {
        return None;
    }
    let pct = ((done * 100) / total).min(100) as u8;
    Some(TaskProgress {
        source_name: source_name.to_string(),
        done,
        total,
        pct,
    })
}

/// 하위 디렉터리의 `.md` 파일들을 mtime 내림차순(최신 먼저)으로 정렬.
/// 읽을 수 없는 항목은 조용히 건너뛴다(결코 죽지 않는다).
fn newest_md_files(dir: &Path) -> Vec<(SystemTime, PathBuf)> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Ok(mtime) = meta.modified() {
            out.push((mtime, path));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    out.truncate(MAX_FILES_PER_DIR);
    out
}

/// 레포 디렉터리에서 태스크 진행률을 찾는다 — 엄격 읽기전용.
///
/// 우선순위: ① 루트 `TODO.md`→`todo.md`→`TASKS.md`→`PLAN.md`→`plan.md`→
/// `.herdr/plan.md` ② `todo/`·`.todo-flow/` 안의 최신 mtime `.md`.
/// 체크박스가 있는(total > 0) 첫 파일을 반환하고, 없으면 `None`.
/// 어떤 파일도 만들거나 쓰지 않는다.
pub fn read_repo_task_progress(repo_dir: &Path) -> Option<TaskProgress> {
    // 1) 루트 파일 — 고정 우선순위 순서.
    for rel in ROOT_CANDIDATES {
        let path = repo_dir.join(rel);
        if !path.is_file() {
            continue;
        }
        if let Some(p) = progress_from_file(&path, rel) {
            return Some(p);
        }
    }
    // 2) 하위 디렉터리 — 최신 mtime .md 먼저.
    for dir_rel in SUBDIR_CANDIDATES {
        let dir = repo_dir.join(dir_rel);
        if !dir.is_dir() {
            continue;
        }
        for (_, path) in newest_md_files(&dir) {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let source_name = format!("{}/{}", dir_rel, name);
            if let Some(p) = progress_from_file(&path, &source_name) {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 프로세스별 고유 임시 디렉터리 — 테스트 끝나면 정리.
    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "dgate-tp-{}-{}-{}",
                tag,
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempRepo(dir)
        }
        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
            p
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_all_bullet_markers_and_states() {
        let md = "- [x] a\n* [X] b\n+ [ ] c\n  - [x] d\n- [x완료] 무관\n- []빈칸없음\n일반 줄";
        assert_eq!(parse_markdown_checkboxes(md), (3, 4));
    }

    #[test]
    fn empty_and_no_checkbox_content() {
        assert_eq!(parse_markdown_checkboxes(""), (0, 0));
        assert_eq!(parse_markdown_checkboxes("# 제목\n본문만"), (0, 0));
    }

    #[test]
    fn fenced_code_block_checkboxes_ignored() {
        let md = "- [x] 완료\n```rust\n- [ ] 코드 안 미완\n- [x] 코드 안 완료\n```\n- [ ] 남은 것\n~~~\n- [x] 틸데 펜스 안\n~~~\n";
        assert_eq!(parse_markdown_checkboxes(md), (1, 2));
    }

    #[test]
    fn unclosed_fence_swallows_rest() {
        let md = "- [x] a\n```\n- [ ] 무한 펜스";
        assert_eq!(parse_markdown_checkboxes(md), (1, 1));
    }

    #[test]
    fn bullet_requires_whitespace_before_bracket() {
        let md = "-[x] 붙은 경우\n- [x] 정상";
        assert_eq!(parse_markdown_checkboxes(md), (1, 1));
    }

    #[test]
    fn root_priority_order_respected() {
        let repo = TempRepo::new("prio");
        // 낮은 우선순위 파일이 더 '최신'이어도 TODO.md가 이긴다.
        repo.write("PLAN.md", "- [x] p\n");
        repo.write("todo.md", "- [x] t1\n- [ ] t2\n");
        repo.write("TODO.md", "- [x] one\n- [ ] two\n- [ ] three\n");
        let tp = read_repo_task_progress(&repo.0).unwrap();
        assert_eq!(
            tp,
            TaskProgress {
                source_name: "TODO.md".to_string(),
                done: 1,
                total: 3,
                pct: 33
            }
        );
    }

    #[test]
    fn falls_back_to_subdir_newest_mtime() {
        let repo = TempRepo::new("subdir");
        repo.write("todo/old.md", "- [ ] 옛날\n");
        let newest = repo.write("todo/sprint.md", "- [x] s1\n- [x] s2\n- [ ] s3\n- [ ] s4\n");
        // sprint.md를 명시적으로 더 최신으로 만든다.
        let now = SystemTime::now();
        let later = now + std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&newest)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let tp = read_repo_task_progress(&repo.0).unwrap();
        assert_eq!(
            tp,
            TaskProgress {
                source_name: "todo/sprint.md".to_string(),
                done: 2,
                total: 4,
                pct: 50
            }
        );
    }

    #[test]
    fn empty_repo_returns_none() {
        let repo = TempRepo::new("empty");
        assert_eq!(read_repo_task_progress(&repo.0), None);
    }

    #[test]
    fn checkbox_free_files_are_skipped() {
        let repo = TempRepo::new("nocheck");
        repo.write("TODO.md", "# 체크박스 없음\n그냥 본문\n");
        repo.write("todo/a.md", "본문만\n");
        assert_eq!(read_repo_task_progress(&repo.0), None);
    }

    #[test]
    fn pct_never_exceeds_100() {
        let md = "- [x] a\n- [x] b\n"; // 100%
        let (done, total) = parse_markdown_checkboxes(md);
        let pct = ((done * 100) / total).min(100) as u8;
        assert_eq!(pct, 100);
    }

    #[test]
    fn read_only_never_creates_files() {
        let repo = TempRepo::new("ro");
        assert!(read_repo_task_progress(&repo.0).is_none());
        // 후보 파일/디렉터리가 하나도 생기지 않았는지 확인.
        for rel in ROOT_CANDIDATES {
            assert!(!repo.0.join(rel).exists(), "{} 생성됨", rel);
        }
        for rel in SUBDIR_CANDIDATES {
            assert!(!repo.0.join(rel).exists(), "{} 생성됨", rel);
        }
    }
}
