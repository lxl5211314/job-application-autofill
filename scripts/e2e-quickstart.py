# T051: quickstart.md S0-S5/S8/S10 端到端验证（Playwright + 加载已解压扩展）
# 运行：python scripts/e2e-quickstart.py
# 说明：headless Chromium 加载 build/chrome-mv3-prod；popup 的「一键填写」在 headless 下
# 无法打开工具栏弹窗，改为直接向内容脚本发送与 popup→background 相同的 autofill:run 消息。

import functools
import http.server
import json
import shutil
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
EXT_DIR = ROOT / "build" / "chrome-mv3-prod"
PROFILE = ROOT / "tests" / ".e2e-profile"
PORT = 8976
BASE = f"http://127.0.0.1:{PORT}"

results = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    results.append((name, bool(cond), detail))
    mark = "PASS" if cond else "FAIL"
    line = f"[{mark}] {name}"
    if detail and not cond:
        line += f" — {detail}"
    print(line, flush=True)
    return bool(cond)


def shadow(page, host_id: str):
    """页内 Shadow DOM 面板（Playwright 自动穿透 open shadow root）"""
    return page.locator(f"#{host_id}")


def panel_text(page, host_id: str) -> str:
    """读取面板文本：host 的 innerText 不含 shadow 内容 → 取内部 .panel-root"""
    root = page.locator(f"#{host_id} .panel-root")
    if root.count() == 0:
        return ""
    return root.first.inner_text()


def run_autofill(sw):
    """等价于 popup 点击：向内容脚本发送 autofill:run（同一消息协议）"""
    t0 = time.time()
    sent = sw.evaluate(
        """async () => {
            const tabs = await chrome.tabs.query({});
            let count = 0;
            for (const tab of tabs) {
              try {
                const r = await chrome.tabs.sendMessage(tab.id, {
                  type: "autofill:run",
                  payload: { startedAt: Date.now() }
                });
                if (r && r.ok) count += 1;
              } catch (e) { /* 无内容脚本的标签页忽略 */ }
            }
            return count;
        }"""
    )
    return t0, sent


def main() -> int:
    # ---- S0: 产物体检（静态） ----
    manifest = json.loads((EXT_DIR / "manifest.json").read_text(encoding="utf-8"))
    check(
        "S0 权限仅 storage/activeTab",
        sorted(manifest.get("permissions", [])) == ["activeTab", "storage"],
        str(manifest.get("permissions")),
    )
    check("S0 pdf.worker.mjs 在包内", (EXT_DIR / "resources" / "pdf.worker.mjs").exists())
    bundle_js = "".join(
        p.read_text(encoding="utf-8", errors="ignore") for p in EXT_DIR.glob("*.js")
    )
    check(
        "S0 无 React/Vue 产物",
        "react-dom" not in bundle_js and "createApp(" not in bundle_js,
    )
    check(
        "S0 无远程脚本加载",
        '<script src="http' not in bundle_js and 'importScripts("http' not in bundle_js,
    )

    # ---- 本地夹具 HTTP 服务（content script 仅匹配 http/https） ----
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURES))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    httpd.log_message = lambda *a, **k: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    if PROFILE.exists():
        shutil.rmtree(PROFILE, ignore_errors=True)

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(PROFILE),
                channel="chromium",  # 完整 Chromium（新 headless 才支持扩展；headless shell 不支持）
                headless=True,
                chromium_sandbox=False,
                args=[
                    f"--disable-extensions-except={EXT_DIR}",
                    f"--load-extension={EXT_DIR}",
                ],
            )

            sw = None
            for _ in range(80):
                workers = context.service_workers
                if workers:
                    sw = workers[0]
                    break
                time.sleep(0.25)
            if sw is None:
                check("扩展 service worker 加载", False, "MV3 SW 未出现")
                context.close()
                return 1
            ext_id = sw.url.split("/")[2]
            check("扩展 service worker 加载", True, ext_id)

            # ---------- S1: options 建档 → 一键填写 ----------
            page = context.new_page()
            page_errors = []
            page.on("pageerror", lambda e: page_errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: page_errors.append(f"console.{m.type}: {m.text}") if m.type in ("error",) else None)
            page.on("crash", lambda _: page_errors.append("PAGE CRASHED"))
            page.goto(f"chrome-extension://{ext_id}/options.html")
            page.wait_for_selector("#options-main")

            def fill(fid: str, value: str):
                page.fill(f'[id="f-{fid}"]', value)

            fill("basic.name", "张三")
            fill("basic.phone", "13812345678")
            fill("basic.email", "zhangsan@example.com")
            fill("basic.school", "清华大学")
            fill("basic.major", "计算机科学与技术")
            fill("basic.degree", "本科")
            fill("basic.political_status", "中共党员")
            page.click('button[data-section="intent"]')
            fill("intent.position", "后端开发工程师")
            fill("intent.city", "北京")
            fill("intent.salary", "15-20K")
            page.get_by_role("button", name="保存全部修改").click()
            page.wait_for_selector("#options-status:text('已保存')", timeout=5000)

            # 教育经历（经 UI 新增，验证 FR-002 分区）
            page.click('button[data-section="education"]')
            page.get_by_role("button", name="新增教育经历").click()
            page.fill('[data-field-id="education.title"] input', "清华大学")
            page.fill('[data-field-id="education.subtitle"] input', "计算机科学与技术")
            page.fill('[data-field-id="education.start"] input', "2020.09")
            page.fill('[data-field-id="education.end"] input', "2024.06")
            page.get_by_role("button", name="完成编辑").click()
            page.get_by_role("button", name="保存全部修改").click()
            page.wait_for_selector("#options-status:text('已保存')", timeout=5000)

            # 实习经历
            page.click('button[data-section="internship"]')
            page.get_by_role("button", name="新增实习经历").click()
            page.fill('[data-field-id="internship.title"] input', "某科技公司")
            page.fill('[data-field-id="internship.subtitle"] input', "后端实习生")
            page.fill('[data-field-id="internship.start"] input', "2023.06")
            page.fill('[data-field-id="internship.end"] input', "2023.12")
            page.get_by_role("button", name="完成编辑").click()
            page.get_by_role("button", name="保存全部修改").click()
            page.wait_for_selector("#options-status:text('已保存')", timeout=5000)
            check("S1 options 建档（六分区保存）", True)

            # popup 冒烟（headless 不打开工具栏弹窗，以标签页方式渲染）
            popup = context.new_page()
            popup.goto(f"chrome-extension://{ext_id}/popup.html")
            popup.wait_for_selector("#btn-run")
            check("S1 popup 渲染", popup.locator("#btn-options").count() == 1)
            popup.close()

            # 打开样例页 → 一键填写
            sample = context.new_page()
            sample.goto(f"{BASE}/sample-form.html")
            sample.wait_for_selector("#name")

            t0, sent = run_autofill(sw)
            check("S1 autofill:run 已派发", sent == 1, f"sent={sent}")

            # SC-006：结果面板 3 秒内出现（T053 首屏即时反馈）
            try:
                shadow(sample, "job-autofill-result").wait_for(state="attached", timeout=3000)
                elapsed = (time.time() - t0) * 1000
                check("S1/SC-006 结果面板 ≤3s 出现", elapsed <= 3000, f"{elapsed:.0f}ms")
            except Exception as e:  # noqa: BLE001
                check("S1/SC-006 结果面板 ≤3s 出现", False, str(e))

            for fid, expect in [
                ("name", "张三"),
                ("phone", "13812345678"),
                ("email", "zhangsan@example.com"),
                ("school", "清华大学"),
                ("major", "计算机科学与技术"),
                ("position", "后端开发工程师"),
                ("city", "北京"),
                ("salary", "15-20K"),
            ]:
                got = sample.input_value(f"#{fid}")
                check(f"S1 字段 #{fid}", got == expect, f"got={got!r}")
            check("S1 学历 select", sample.input_value("#degree") == "bachelor", sample.input_value("#degree"))
            check(
                "S1 政治面貌 radio",
                sample.is_checked('input[name="political"][value="中共党员"]'),
            )
            check(
                "S1 排除项 联系人姓名不填",
                sample.input_value("#contact_name") == "",
                sample.input_value("#contact_name"),
            )

            # 教育/实习表格（经验列）+ 缺资料行
            edu1 = sample.locator('input[name="edu1_school"]')
            edu1.wait_for(timeout=3000)
            check("S1 教育表格行1 学校", edu1.input_value() == "清华大学", edu1.input_value())
            check(
                "S1 教育表格行2 缺资料",
                sample.locator('input[name="edu2_school"]').input_value() == "",
            )
            intern = sample.locator('input[name="intern1_company"]')
            check("S1 实习表格行1 公司", intern.input_value() == "某科技公司", intern.input_value())

            # S8 安全边界：黑名单控件不触碰 + 预填冲突不覆盖
            check("S8 密码框未填", sample.input_value("#pwd") == "")
            check("S8 文件上传未动", sample.locator("#resume_file").input_value() == "")
            check("S8 验证码未填", sample.input_value("#captcha") == "")
            check("S8 协议勾选未动", not sample.is_checked("#agree"))
            check("S8 提交按钮未动", sample.locator("#btn-submit").inner_text() == "提交简历")
            check(
                "S8 预填冲突不覆盖（联系电话）",
                sample.input_value("#contact_phone") == "010-12345678",
                sample.input_value("#contact_phone"),
            )

            # 结果清单分类（FR-014）
            panel_text_value = panel_text(sample, "job-autofill-result")
            check(
                "S8 结果清单含 需人工处理",
                "提交简历" in panel_text_value and "需人工处理" in panel_text_value,
                panel_text_value[:300],
            )
            check(
                "S8 结果清单含 资料缺失",
                "资料缺失" in panel_text_value,
                panel_text_value[:300],
            )
            check(
                "S10 结果面板展示掩码（无完整手机号）",
                "13812345678" not in panel_text_value,
                panel_text_value[:300],
            )

            # 确认面板：低置信/冲突 → 待确认（FR-013/S2）
            try:
                shadow(sample, "job-autofill-confirm").wait_for(state="attached", timeout=8000)
                check("S2 确认面板弹出（冲突/歧义待确认）", True)
            except Exception:  # noqa: BLE001
                check("S2 确认面板弹出（冲突/歧义待确认）", False, "8s 未出现")

            pick_btn = shadow(sample, "job-autofill-confirm").get_by_role(
                "button", name="13812345678"
            )
            if pick_btn.count() > 0:
                pick_btn.first.click()
                try:
                    sample.wait_for_function(
                        "() => document.querySelector('#contact_phone').value === '13812345678'",
                        timeout=3000,
                    )
                    check("S2 点选候选 → 冲突字段填入", True)
                except Exception:  # noqa: BLE001
                    check("S2 点选候选 → 冲突字段填入", False, "值未变化")
            else:
                check("S2 点选候选 → 冲突字段填入", False, "候选按钮未找到")

            # 跳过「自我评价」→ 保持页面原状（FR-023 skip 不填）
            skip = shadow(sample, "job-autofill-confirm").get_by_role(
                "button", name="跳过（保持页面原状）"
            )
            if skip.count() > 0:
                skip.first.click()
                time.sleep(0.5)
                check(
                    "S2/FR-023 跳过 → 自我评价保持原状",
                    sample.input_value("#selfeval") == "",
                )
            else:
                check("S2/FR-023 跳过 → 自我评价保持原状", False, "跳过按钮未找到")

            # ---------- S2/S3/FR-016: step2 页 ----------
            sample.close()
            step2 = context.new_page()
            step2.goto(f"{BASE}/sample-form-step2.html")
            step2.wait_for_selector("#degree_step2")

            t0, sent = run_autofill(sw)
            check("S3 step2 autofill:run 已派发", sent == 1, f"sent={sent}")

            try:
                step2.wait_for_function(
                    "() => document.querySelector('#late_phone')?.value === '13812345678'",
                    timeout=8000,
                )
                check("FR-016 动态追加字段被补扫填入", True)
            except Exception:  # noqa: BLE001
                check("FR-016 动态追加字段被补扫填入", False, "late_phone 未填")

            try:
                shadow(step2, "job-autofill-confirm").wait_for(state="attached", timeout=8000)
                ctext = panel_text(step2, "job-autofill-confirm")
                check("S2 学历措辞不一致 → 确认面板", "学历要求" in ctext, ctext[:200])
            except Exception:  # noqa: BLE001
                check(
                    "S2 学历措辞不一致 → 确认面板",
                    False,
                    panel_text(step2, "job-autofill-confirm")[:200] or "确认面板未出现",
                )
            check(
                "S2 未自动填写学历 select",
                step2.input_value("#degree_step2") == "",
                step2.input_value("#degree_step2"),
            )

            btn = shadow(step2, "job-autofill-confirm").get_by_role(
                "button", name="本科及以上（含专升本）"
            )
            if btn.count() > 0:
                btn.first.click()
                try:
                    step2.wait_for_function(
                        "() => document.querySelector('#degree_step2').value === 'a'",
                        timeout=3000,
                    )
                    check("S2 点选后学历填入", True)
                except Exception:  # noqa: BLE001
                    check("S2 点选后学历填入", False, "select 未变化")
            else:
                check("S2 点选后学历填入", False, "候选按钮未找到")

            time.sleep(1.0)  # 等 confirm:resolve 记忆落库

            # S3：刷新后再次一键填写 → 记忆命中，不再询问、直接填
            step2.reload()
            step2.wait_for_selector("#degree_step2")
            t0, sent = run_autofill(sw)
            try:
                step2.wait_for_function(
                    "() => document.querySelector('#degree_step2').value === 'a'",
                    timeout=8000,
                )
                check("S3/FR-021 刷新后记忆命中直接填入", True)
            except Exception:  # noqa: BLE001
                check("S3/FR-021 刷新后记忆命中直接填入", False, "select 未自动填")
            time.sleep(4.5)  # 等待会话结束（若弹面板则说明未记忆）
            check(
                "S3 记忆命中后不再弹确认面板",
                step2.locator("#job-autofill-confirm").count() == 0,
                f"count={step2.locator('#job-autofill-confirm').count()}",
            )
            step2.close()

            # ---------- S4: 文本型 PDF 导入 ----------
            page.bring_to_front()
            page.click('button[data-section="import"]')
            page.set_input_files("#resume-file", str(FIXTURES / "resume-text.pdf"))
            time.sleep(4)
            try:
                page.wait_for_selector("text=简历导入核对", timeout=16000)
                draft_ok = True
                draft_diag = ""
            except Exception:  # noqa: BLE001
                draft_ok = False
                main_text = (
                    page.locator("#options-main").inner_text()[:400]
                    if page.locator("#options-main").count()
                    else "(main 缺失)"
                )
                draft_diag = (
                    f"status={page.locator('#import-status').count()} "
                    f"fileinput={page.locator('#resume-file').count()} "
                    f"url={page.url} main={main_text!r} errors={page_errors[-5:]}"
                )
            check("S4 文本型 PDF 打开草稿核对页", draft_ok, draft_diag)
            if not draft_ok:
                context.close()
                return 1
            draft_name = page.input_value('[id="draft-basic.name"]')
            draft_phone = page.input_value('[id="draft-basic.phone"]')
            draft_salary = page.input_value('[id="draft-intent.salary"]')
            check(
                "S4 姓名/手机预填",
                draft_name == "张三" and draft_phone == "13812345678",
                f"{draft_name}/{draft_phone}",
            )
            check("S4 未读取字段留空", draft_salary == "", draft_salary)
            check("S4 低置信标记待核对", page.locator(".badge.needs_review").count() > 0)
            check("S4 读取不到的字段标未读取到", page.locator("text=未读取到").count() > 0)
            check("S4 经历条目预填", page.locator(".draft-entry").count() >= 1)

            page.check("#import-mode-overwrite")
            page.get_by_role("button", name="确认导入").click()
            page.wait_for_selector("#options-status:text('已导入')", timeout=10000)
            check("S4 覆盖导入成功", True)
            page.click('button[data-section="intent"]')
            check(
                "S4 覆盖后求职意向清空（整体替换）",
                page.input_value('[id="f-intent.salary"]') == "",
                page.input_value('[id="f-intent.salary"]'),
            )
            page.click('button[data-section="internship"]')
            check(
                "S4 覆盖后实习条目来自简历",
                "字节跳动" in page.locator("#options-entries-internship").inner_text(),
            )

            # ---------- S5: 扫描件（无文本层）→ 报错且不建草稿 ----------
            page.click('button[data-section="import"]')
            page.set_input_files("#resume-file", str(FIXTURES / "resume-scan.pdf"))
            try:
                page.locator("#import-status", has_text="无法读取文字").wait_for(timeout=20000)
                check("S5 扫描件提示无法读取文字", True)
            except Exception:  # noqa: BLE001
                status = (
                    page.locator("#import-status").inner_text()
                    if page.locator("#import-status").count()
                    else "(无状态)"
                )
                check("S5 扫描件提示无法读取文字", False, status)
            check(
                "S5 扫描件不产生草稿核对页",
                page.locator("text=简历导入核对").count() == 0,
            )

            # ---------- S10: 个人数据仅在本机 ----------
            storage_keys = sw.evaluate(
                "async () => Object.keys(await chrome.storage.local.get(null))"
            )
            check(
                "S10 数据存于 chrome.storage.local",
                any(k in storage_keys for k in ("profile", "entries", "memory", "reports")),
                str(storage_keys),
            )

            context.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(PROFILE, ignore_errors=True)

    failed = [(n, d) for n, ok, d in results if not ok]
    total = len(results)
    print("-" * 60)
    print(f"总计 {total} 项，通过 {total - len(failed)}，失败 {len(failed)}")
    for n, d in failed:
        print(f"  FAIL: {n} — {d}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
