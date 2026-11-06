# API-01／API-02：真實本機HTTP與預覽

每個案例使用系統暫存repository、127.0.0.1隨機連接埠及合成process token。HTTP入口真正組合FileRepository、ContentService、MediaService、JobManager、OperationStore、ArtifactStore與BuildCoordinator，不啟動專案dev服務，也不寫入正式content/dist。

smallBuild僅透過內部BuildCoordinator.execution注入，驗證HTTP dispatch、snapshot/CAS、持久job與真實artifact promotion；不把小型HTML視為Astro SSG完成。正式worker整合由site-render與build-coordinator測試負責。圖片/影片測試以Sharp/FFmpeg實際產生並處理素材，沒有產品假成功端點。

預覽以共用React ArticlePage、Core previewArticle及編譯CSS產生，測試sandbox CSP、受控媒體URL映射、編輯器替換、容量、到期與重啟404；保存原文以hash/bytes核對。

ETag案例核對Article diagnostics／Media asset變化後的完整表示強版本、canonical GET／201 replay bytes、內部raw CAS與Node-only inputRevision分離、queued media不因asset完成而誤判來源更新。故障案例在prepared階段改跨來源、committed後模擬IDE第三版、實際持有全部image slots，以及將私有inspection cache設為500，核對版本保護、成功snapshot、writer鎖順序與可選cache失敗行為；這些異常只施於暫存repository。
