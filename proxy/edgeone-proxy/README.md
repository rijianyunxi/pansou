# EdgeOne Makers 上传目录

在 EdgeOne Makers 中选择“直接上传”，上传当前 `edgeone-proxy` 目录。

函数入口为：

```text
edge-functions/[[default]].js
```

部署后访问：

```text
https://你的域名/https://example.com
```

只允许代理 `GET` 和 `HEAD` 请求，并支持把代理地址后的查询参数传递给目标网站。
