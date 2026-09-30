# 离线激活维护说明

客户端首次启动会显示本机挑战码。用户把挑战码发给销售方后，在开发电脑运行：

```powershell
npm run license:generate
```

也可以双击被 Git 忽略的 `.license-private/生成激活码.cmd`。依次输入挑战码、客户名称和订单编号，工具会输出永久绑定该设备的激活码。

私钥位于 `.license-private/private-key.pem`，公钥位于 `src/license/public-key.pem`。私钥不会进入 Git 或 Electron 发行包；丢失私钥后无法为已经发布的公钥继续签发新授权，因此必须另外保存一份加密离线备份。替换公钥会使旧激活码全部失效。

新环境尚未创建密钥时，只运行一次：

```powershell
npm run license:init
```

如需生成加密私钥，可在第一次初始化前设置 `LICENSE_KEY_PASSWORD`。以后签发时也必须设置相同的环境变量。不要在已经销售软件后重新初始化密钥。
