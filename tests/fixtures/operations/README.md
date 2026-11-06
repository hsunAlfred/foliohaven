# Operation persistence fixtures

對應 JOB-01 的冪等保存與回應遺失處理。worker.mts 在系統暫存 repository 真正取得 operation lease、保留 reservation，並在 FileRepository commit 完成後直接 exit；父測試核對 journal receipt 重取、原始 response、固定七天 expiry、同 key 衝突與 owner 存活的保護。

response 裡的文字均為合成素材；不輸出或存入 repository 的報告。fixture 不提供產品可選的假成功 worker，也不使用正式文章或認證資料。完整 API HTTP headers 與錯誤封裝仍由 API 整合測試驗收。
