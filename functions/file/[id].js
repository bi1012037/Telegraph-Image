export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);
    let fileUrl = 'https://telegra.ph' + url.pathname + url.search;
    let filePathForMime = fileUrl; // 預設用來猜 MIME 類型

    if (url.pathname.length > 39) {
        const fileId = url.pathname.split(".")[0].split("/")[2];
        console.log(fileId);

        const filePath = await getFilePath(env, fileId);
        console.log(filePath);

        if (!filePath) return new Response("Failed to get Telegram file", { status: 500 });

        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        filePathForMime = filePath; // 使用 Telegram 的真實 file path 猜 MIME
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

    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return await withInlineDisposition(response, filePathForMime);
    }

    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        console.log("Metadata not found, initializing...");
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

    if (metadata.ListType === "White") {
        return await withInlineDisposition(response, filePathForMime);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer
            ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
            : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=${fileUrl}`;
            const moderateResponse = await fetch(moderateUrl);

            if (moderateResponse.ok) {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData?.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            } else {
                console.error("Moderation API failed", moderateResponse.status);
            }
        } catch (err) {
            console.error("Moderation error:", err.message);
        }
    }

    await env.img_url.put(params.id, "", { metadata });

    return await withInlineDisposition(response, filePathForMime);
}

// 自動推測 Content-Type
function guessMimeType(filePath = "") {
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
    if (filePath.endsWith(".png")) return "image/png";
    if (filePath.endsWith(".gif")) return "image/gif";
    if (filePath.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
}

// 強制 inline 顯示 + 修正 Content-Type
async function withInlineDisposition(response, filePath = "") {
    const headers = new Headers(response.headers);
    headers.set("Content-Disposition", "inline");

    // 若 Telegram 回傳錯的 Content-Type，修正為正確類型
    const currentType = headers.get("Content-Type");
    if (!currentType || currentType === "application/octet-stream") {
        headers.set("Content-Type", guessMimeType(filePath));
    }

    return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// Telegram API: 取得檔案路徑
async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url);

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const json = await res.json();
        return json.ok && json.result ? json.result.file_path : null;
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}
