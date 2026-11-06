# 檔案交易故障素材

對應 `SAVE-01`／`SAVE-02`。`transactions.test.ts` 每案在系統暫存目錄建立自己的 HTML／JSON、媒體與 `.alfred`，不寫正式 content、media 或 dist。

`worker.mts` 只供測試內部啟動，使用真正 FileRepository、flock、rename／exclusive link 及 fsync。固定模式是持鎖、保存及復原決議；phase hook 直接以 exit 77 中止程序，父測試重新建立 repository 並核對真正檔案及 journal。另以 SIGKILL 驗證 owner 死亡釋鎖，以真實目錄權限驗證 EACCES，以內部 hook 注入 ENOSPC 或在提交邊界修改來源。產品沒有可用 request 或環境變數啟用這些故障。

保留政策使用內部可控時鐘，驗證至少 7 天且最近 20 筆成功備份、30 天 trash 與明確 purge；不等待真實天數。未知版本以實際文字與二進位測試，驗證 base／prepared／current／preserved 與 fileId 受控下載。所有自建程序、stream 與暫存資料於測試結束回收。

正常保存與 trash 以 `available` 表示可查看或還原，未知交易才是 `pending`；還原後為 `resolved`，原始操作回應仍可重取。還原目錄採 exclusive mkdir 及持久 dev／ino 所有權；在建立目錄與記錄所有權之間中止時，須留下復原阻擋，不能猜測空目錄屬於本交易。測試另核對壞 journal 不會擴張至其他目錄，並在整份測試前後比對正式 content／media/source／dist digest。

工程指令見[README](../../../README.md)，此組範圍由 `transactions.test.ts` 的真實隔離執行驗證；fixture存在不代表本次驗收通過，實際指令、環境與結果另依當次工作記錄。
