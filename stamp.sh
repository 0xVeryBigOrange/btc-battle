#!/bin/sh
# 部署前运行：给 CSS/JS 引用加上内容哈希版本号，避免浏览器缓存旧文件
cd "$(dirname "$0")"
V=$(sed -E 's/\?v=[A-Za-z0-9]+//g' index.html style.css js/*.js | sha1sum | cut -c1-8)
sed -i -E "s/(style\.css|app\.js)\?v=[A-Za-z0-9]+/\1?v=$V/g" index.html
sed -i -E "s/(feeds\.js|battle\.js|music\.js)\?v=[A-Za-z0-9]+/\1?v=$V/g" js/app.js
echo "version $V"
