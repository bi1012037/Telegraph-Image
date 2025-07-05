export async function onRequest(context) {
    const { request, env, params } = context;

    const url = new URL(request.url);
    let fileUrl = 'https://telegra.ph' + url.pathname + url.search;
    let filePathForMime = fileUrl;

    // 若是 Telegram Bot API 上傳的圖片
    if (url.pathname.length > 39) {
        const fileId = url.pathname.split(".")[0].split("/")[2];
        const filePath = await getFilePath(env, fileId);
        if (!filePath) return new Response("Failed to get Telegram file", { status: 500 });

        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        filePathForMime = filePath;
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    if (!response.ok) return response;

    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return await withInlineDisposition(response, filePathForMime);
    }

    // 沒有 KV，直接回應圖片
    if (!env.img_url) {
        return await withInlineDisposition(response, filePathForMime);
    }

    // 取得或初始化 metadata
    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // 黑名單處理
    if (metadata.ListType === "White") {
        return await withInlineDisposition(response, filePathForMime);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer
            ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
            : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // 若啟動白名單模式
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // 自動內容分類
    if (env.ModerateContentApiKey) {
        try {
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=${fileUrl}`;
            const moderateResponse = await fetch(moderateUrl);

            if (moderateResponse.ok) {
                const moderateData = await moderateResponse.json();
                if (moderateData?.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (err) {
            console.error("Moderation error:", err.message);
        }
    }

    await env.img_url.put(params.id, "", { metadata });

    return await withInlineDisposition(response, filePathForMime);
}

// ========= 🔧 Helper: 加入 inline 並修正 Content-Type =========
async function withInlineDisposition(response, filePath = "") {
    const headers = new Headers(response.headers); // ✅ 保留原始 headers

    // 修正 Content-Type（避免 octet-stream 造成下載）
    const currentType = headers.get("Content-Type");
    if (!currentType || currentType === "application/octet-stream") {
        headers.set("Content-Type", guessMimeType(filePath));
    }

    // 強制瀏覽器用 inline 顯示
    headers.set("Content-Disposition", "inline");

    return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// ========= 🔧 Helper: 推測 MIME 類型 =========
function guessMimeType(filePath = "") {
    filePath = filePath.toLowerCase();
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
    if (filePath.endsWith(".png")) return "image/png";
    if (filePath.endsWith(".gif")) return "image/gif";
    if (filePath.endsWith(".webp")) return "image/webp";
    if (filePath.endsWith(".bmp")) return "image/bmp";
    if (filePath.endsWith(".ico")) return "image/x-icon";
    if (filePath.endsWith(".svg")) return "image/svg+xml";
    if (filePath.endsWith(".tif") || filePath.endsWith(".tiff")) return "image/tiff";
    //嘗試新增mp3、mp4、pdf
    if (filePath.endsWith(".mp3")) return "audio/mpeg";
    if (filePath.endsWith(".pdf")) return "application/pdf";
    if (filePath.endsWith(".mp4")) return "video/mp4";
    return "application/octet-stream";
}

// ========= 🔧 Helper: 取得 Telegram 檔案路徑 =========
async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url);
        if (!res.ok) return null;

        const json = await res.json();
        return json.ok && json.result ? json.result.file_path : null;
    } catch (error) {
        console.error('Error fetching Telegram file path:', error.message);
        return null;
    }
}
