(() => {
  const maxBytes = 6 * 1024 * 1024;
  const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const choose = document.getElementById("photoChoose");
  const input = document.getElementById("photoInput");
  const draft = document.getElementById("photoDraft");
  const preview = document.getElementById("photoDraftPreview");
  const name = document.getElementById("photoDraftName");
  const send = document.getElementById("photoSend");
  const cancel = document.getElementById("photoCancel");
  const status = document.getElementById("photoStatus");
  const viewer = document.getElementById("photoViewer");
  const fullImage = document.getElementById("photoFullImage");
  const viewerStatus = document.getElementById("photoViewerStatus");
  const download = document.getElementById("photoDownload");
  let selected;
  let previewURL;
  let uploading = false;
  let opener;

  function clearDraft() {
    selected = undefined;
    input.value = "";
    preview.removeAttribute("src");
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = undefined;
    draft.classList.add("hidden");
  }

  choose.addEventListener("click", () => input.click());
  cancel.addEventListener("click", () => {
    if (uploading) return;
    clearDraft();
    status.textContent = "";
    choose.focus();
  });
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    clearDraft();
    const extension = file.name.split(".").pop().toLowerCase();
    const type = types[extension];
    if (!type || (file.type && file.type !== type)) {
      status.textContent = "仅支持 JPG、PNG 和 WebP，暂不支持 HEIC。";
      return;
    }
    if (!file.size || file.size >= maxBytes) {
      status.textContent = "请选择非空且小于 6MB 的图片。";
      return;
    }
    selected = { file, type };
    previewURL = URL.createObjectURL(file);
    preview.src = previewURL;
    name.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    draft.classList.remove("hidden");
    status.textContent = "确认预览后点击“发送图片”。";
  });
  preview.addEventListener("error", () => {
    if (!selected || uploading) return;
    clearDraft();
    status.textContent = "图片无法预览，请重新选择有效的 JPG、PNG 或 WebP 图片。";
  });

  send.addEventListener("click", () => {
    if (!selected || uploading) return;
    uploading = true;
    choose.disabled = send.disabled = cancel.disabled = true;
    draft.setAttribute("aria-busy", "true");
    status.textContent = "正在上传图片…";
    const request = new XMLHttpRequest();
    request.open("POST", "/api/photos");
    request.timeout = 60000;
    request.setRequestHeader("Content-Type", selected.type);
    request.setRequestHeader("X-File-Name", encodeURIComponent(selected.file.name));
    request.upload.addEventListener("progress", event => {
      if (event.lengthComputable) {
        const percent = Math.round(event.loaded / event.total * 100);
        status.textContent = percent < 100 ? `正在上传图片… ${percent}%` : "上传完成，正在处理图片…";
      }
    });
    request.addEventListener("load", () => {
      if (request.status !== 201) {
        status.textContent = request.responseText || "上传失败，请稍后重试。";
        return;
      }
      try {
        const message = JSON.parse(request.responseText);
        document.dispatchEvent(new CustomEvent("photo-uploaded", { detail: message }));
        clearDraft();
        status.textContent = "图片已发送。";
      } catch {
        status.textContent = "无法确认发送结果，请刷新聊天室确认后再试。";
      }
    });
    const uncertain = () => { status.textContent = "网络中断或上传超时，请刷新聊天室确认是否发送成功后再试。"; };
    request.addEventListener("error", uncertain);
    request.addEventListener("timeout", uncertain);
    request.addEventListener("loadend", () => {
      uploading = false;
      choose.disabled = send.disabled = cancel.disabled = false;
      draft.removeAttribute("aria-busy");
    });
    request.send(selected.file);
  });

  document.getElementById("photoViewerClose").addEventListener("click", () => viewer.close());
  viewer.addEventListener("click", event => {
    const bounds = viewer.getBoundingClientRect();
    if (event.target === viewer && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) viewer.close();
  });
  viewer.addEventListener("close", () => {
    fullImage.removeAttribute("src");
    document.body.classList.remove("photo-viewer-open");
    opener?.focus();
  });
  fullImage.addEventListener("load", () => { viewerStatus.textContent = ""; });
  fullImage.addEventListener("error", () => {
    if (viewer.open) viewerStatus.textContent = "图片加载失败，请关闭后重试；登录失效时请重新登录。";
  });

  window.chatPhotos = {
    createThumbnail(image) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-photo";
      button.setAttribute("aria-label", `查看图片：${image.filename}`);
      const thumbnail = document.createElement("img");
      thumbnail.src = image.thumbnail;
      thumbnail.alt = image.filename;
      thumbnail.loading = "lazy";
      thumbnail.width = image.width;
      thumbnail.height = image.height;
      thumbnail.addEventListener("error", () => { thumbnail.alt = "图片加载失败，点击重试查看原图"; });
      button.appendChild(thumbnail);
      button.addEventListener("click", () => {
        opener = button;
        viewerStatus.textContent = "正在加载原图…";
        fullImage.alt = image.filename;
        fullImage.src = image.url;
        download.href = image.download;
        download.download = image.filename;
        document.body.classList.add("photo-viewer-open");
        viewer.showModal();
      });
      return button;
    },
  };
})();
