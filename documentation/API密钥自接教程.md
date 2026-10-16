# 如何自接 API

### 我们的软件需要两个 API：DeepSeek API（用于问答） 和 语音识别 API（可选阿里云或腾讯云）。如果您熟悉 API 的使用，在 DeepSeek 这里可以直接填上任意 OpenAI 格式 API，但语音识别还是需要用阿里云百炼/腾讯云。

为什么自接API？相比30-70元一次或按小时计费的面试辅助服务，自接API按用量计费更便宜，面试一次消耗仅在一元左右。此外，在本地不经过中转直接调API，可以让AI回答更快速，并保护个人的隐私。

### 首先填写对话模型API：

![Screenshot 2026-10-14 165319](C:\Users\19902\Pictures\Screenshots\Screenshot 2026-10-14 165319.png)

### 然后在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 获取 API Key。

### 首次登录需要注册账号，并预充一定费用，一次面试大概几毛钱到一块钱 token 费。

![Screenshot 2026-10-09 181811](D:\code\GitHub\cheating-daddy\documentation\Screenshot 2026-10-09 181811.png)

![image-20261010115600993](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261010115600993.png)

### 创建密钥成功后，在弹出的窗口复制并粘贴到软件“API 密钥”对应位置即可。

### 接下来获取 [阿里云百炼平台](https://bailian.console.aliyun.com/) 的 API：

![Screenshot 2026-10-14 165331](C:\Users\19902\Pictures\Screenshots\Screenshot 2026-10-14 165331.png)

![image-20261010115543229](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261010115543229.png)

### 首次登录同样需要注册账号。阿里云语音识别很便宜，充个几块钱就行

![image-20261010121337130](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261010121337130.png)

### 在默认业务空间创一个 API key：

![image-20261010122815595](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261010122815595.png)

![Screenshot 2026-10-09 182139](D:\code\GitHub\cheating-daddy\documentation\Screenshot 2026-10-09 182139.png)

### 复制后粘贴到软件内即可。

### 如果您由于地区原因无法使用阿里云百炼的服务或较为卡顿，可以改用腾讯云：

（腾讯云每个月有免费额度，但用完后购买比较昂贵）

![Screenshot 2026-10-14 165346](C:\Users\19902\Pictures\Screenshots\Screenshot 2026-10-14 165346.png)

### 首先注册腾讯云账户，获得AppID：

![image-20261014172113441](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261014172113441.png)

![Screenshot 2026-10-14 171541](C:\Users\19902\Pictures\Screenshots\Screenshot 2026-10-14 171541.png)

### 接下来获取密钥（SecretId和SecretKey）：

![image-20261014172258275](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261014172258275.png)

### 腾讯云可能会提示您用子账户注册密钥，不过这样太过复杂，只要不把您的密钥发给其他人就没问题。

![image-20261014172717022](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261014172717022.png)

### 创建后得到 SecretId 和 SecretKey：

![image-20261014172420500](C:\Users\19902\AppData\Roaming\Typora\typora-user-images\image-20261014172420500.png)

### 填入软件对应位置即可。
