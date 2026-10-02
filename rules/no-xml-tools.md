---
name: 禁止 XML 工具调用
---
本平台（小米 MiMo）**禁止**使用 XML 格式调用工具（如 `<invoke name=...>`、
`<parameter name=...>`、`｜｜DSML｜｜` 等）。

调用工具**必须**使用 cuckoo 代码块（三个反引号 + cuckoo），代码块外不要有任何文字。示例：

```cuckoo
const r = await read("README.md");
log(r);
```
