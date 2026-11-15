"""Pinned compatibility patches; refuse unknown or divergent upstream bytes."""
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1]) / 'node_modules/@wonderwhy-er/desktop-commander'
assert json.loads((root/'package.json').read_text())['version'] == '0.3.3'
changes = {
    'dist/tools/improved-process-tools.js': [
        ('text: `${statusMessage}\\n\\n${responseText}${processStateMessage}${timingMessage}`\n            }],',
         'text: `${statusMessage}\\n\\n${responseText}${processStateMessage}${timingMessage}`\n            }],\n        structuredContent: { pid, isComplete: result.isComplete, exitCode: result.exitCode, signal: result.signal ?? null, output, remaining: result.remaining, evictedLines: result.evictedLines ?? 0 },')],
    'dist/index.js': [
        ('await featureFlagManager.initialize();', "if (process.env.ANYWHERE_DC_MINIMAL !== '1') await featureFlagManager.initialize();"),
        ('ensureChromeAvailable();', "if (process.env.ANYWHERE_DC_MINIMAL !== '1') ensureChromeAvailable();"),
        ('preloadFileSupport();', "if (process.env.ANYWHERE_DC_MINIMAL !== '1') preloadFileSupport();")],
    'dist/tools/edit.js': [
        ('return {\n            content: [{\n                    type: "text",\n                    text: "Empty search strings',
         'return {\n            isError: true,\n            content: [{\n                    type: "text",\n                    text: "Empty search strings'),
        ('return {\n            content: [{\n                    type: "text",\n                    text: `Expected ${expectedReplacements}',
         'return {\n            isError: true,\n            content: [{\n                    type: "text",\n                    text: `Expected ${expectedReplacements}'),
        ('return {\n                content: [{\n                        type: "text",\n                        text: `Exact match not found',
         'return {\n                isError: true,\n                content: [{\n                        type: "text",\n                        text: `Exact match not found'),
        ('return {\n                content: [{\n                        type: "text",\n                        text: `Search content not found',
         'return {\n                isError: true,\n                content: [{\n                        type: "text",\n                        text: `Search content not found')],
    'dist/handlers/filesystem-handlers.js': [
        ('return { content: contentItems };',
         'return { content: contentItems, isError: fileResults.some(result => Boolean(result.error)), structuredContent: { errors: fileResults.filter(result => result.error).map(result => ({ path: result.path, error: result.error })) } };')],
    'dist/utils/internal-facts.js': [
        ('export function withoutInternalFacts(toolName, result) {',
         "export function withoutInternalFacts(toolName, result) {\n    if (process.env.ANYWHERE_DC_MINIMAL === '1') return result;")],
    'dist/terminal-manager.js': [
        ("childProcess.on('exit', (code, signal) => {", "childProcess.on('close', (code, signal) => {")]
}
report = []
expected = {
    'dist/index.js': '7e58b9d5d64732ff8cd77cd477de30751feb6b59bc2353dfaa78825f015b2f2b',
    'dist/tools/improved-process-tools.js': 'e0be1ddbec830a209d00cff6bee3d737eae9656cfafbc8aeeccbff97290c6602',
    'dist/tools/edit.js': '7deaf395ba6d53bb0f8410baeac30a2c10d2a5c921e0bcf720b01f86f8f4dd41',
    'dist/handlers/filesystem-handlers.js': '667771f5439092c0554fa54313fbcb24a7762ffe6c7e4ed29f51dedcd52f417f',
    'dist/utils/internal-facts.js': '1d89d2040ff852cf04edfdfcf4eda523576a28cb1ff189333dc11f771f4397fc',
    'dist/terminal-manager.js': '020bbcc524cef58a6e2413e2b5386672a587abf97ade8452ca2d659c8ec24c60',
}
for name, replacements in changes.items():
    target = root/name
    original = target.with_suffix(target.suffix+'.upstream')
    if not original.exists(): original.write_bytes(target.read_bytes())
    assert hashlib.sha256(original.read_bytes()).hexdigest() == expected[name], f'Unpinned source: {name}'
    content = original.read_text()
    for old,new in replacements:
        assert content.count(old) == 1, name
        content = content.replace(old,new)
    accepted = [original.read_bytes(), content.encode()]
    # Allow the earlier, fully specified local patch revision used during this
    # validation (an unused stdin-output field). Never accept arbitrary edits.
    if name == 'dist/tools/improved-process-tools.js':
        accepted.append(content.replace('const structuredContent = {\n            pid,',
            'const structuredContent = {\n            output: cleanOutput,\n            pid,').encode())
    assert target.read_bytes() in accepted, f'Divergent vendor file: {name}'
    target.write_text(content)
    report.append(dict(path=name, beforeSha256=hashlib.sha256(original.read_bytes()).hexdigest(),
                       afterSha256=hashlib.sha256(target.read_bytes()).hexdigest()))
print(json.dumps(report,indent=2))
