// =========================================================
// CHECKED ORYN — Servers
// Servers, channels, live chat, roles (owner / admin /
// moderator / member) and image + GIF attachments.
// Requires supabase/servers.sql to have been run once.
// =========================================================

const db = window.supabaseClient;

const ATTACHMENT_BUCKET = "server-attachments";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
};

const ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };
const ROLE_LABEL = { owner: "Owner", admin: "Admin", moderator: "Moderator", member: "Member" };

// ---------------------------------------------------------
// STATE
// ---------------------------------------------------------

const state = {
    me: null,
    myProfile: null,
    servers: [],            // { id, name, invite_code, owner_id, role }
    serverId: null,
    channels: [],
    channelId: null,
    members: [],            // { user_id, role, joined_at }
    profiles: new Map(),    // user_id -> { id, username, display_name }
    pendingFile: null,
    realtime: null,
    sending: false
};

// ---------------------------------------------------------
// DOM HELPERS
// ---------------------------------------------------------

const $ = id => document.getElementById(id);

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

const app = $("srvApp");
const messageList = $("messageList");
const composer = $("composer");
const messageInput = $("messageInput");

function rankOf(role) {
    return ROLE_RANK[role] ?? 0;
}

function myRole() {
    return state.servers.find(s => s.id === state.serverId)?.role || null;
}

function myRank() {
    const role = myRole();
    return role ? rankOf(role) : -1;
}

function currentServer() {
    return state.servers.find(s => s.id === state.serverId) || null;
}

function currentChannel() {
    return state.channels.find(c => c.id === state.channelId) || null;
}

function nameOf(userId) {
    const p = state.profiles.get(userId);
    return p?.display_name || p?.username || "Unknown user";
}

function handleOf(userId) {
    const p = state.profiles.get(userId);
    return p?.username ? "@" + p.username : "";
}

function initialOf(userId) {
    return nameOf(userId).charAt(0).toUpperCase();
}

function roleOfUser(userId) {
    return state.members.find(m => m.user_id === userId)?.role || null;
}

function errorText(error) {
    const text = error?.message || "Something went wrong.";

    if (/relation .* does not exist|schema cache|Could not find the (table|function)/i.test(text)) {
        return "Servers aren't set up in Supabase yet. Run supabase/servers.sql in the SQL Editor.";
    }

    return text;
}

let toastTimer = null;
function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function formatTime(date) {
    const d = new Date(date);
    const sameDay = d.toDateString() === new Date().toDateString();

    return sameDay
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ }
}

function recall(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

// ---------------------------------------------------------
// MODALS
// ---------------------------------------------------------

function openModal(id) {
    const modal = $(id);
    modal.hidden = false;
    modal.querySelectorAll("[data-error]").forEach(n => { n.textContent = ""; });
    const input = modal.querySelector("input[type='text']");
    if (input) setTimeout(() => input.focus(), 30);
}

function closeModals() {
    document.querySelectorAll(".modal-backdrop").forEach(m => { m.hidden = true; });
    hideMemberMenu();
}

document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("mousedown", event => {
        if (event.target === backdrop) closeModals();
    });
});

document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", closeModals);
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeModals();
});

function setModalError(modalId, message) {
    // Several forms can share a modal (create / join): use the visible one.
    const nodes = [...$(modalId).querySelectorAll("[data-error]")];
    const node = nodes.find(n => !n.closest("[hidden]")) || nodes[0];
    if (node) node.textContent = message;
}

// ---------------------------------------------------------
// LOADING DATA
// ---------------------------------------------------------

async function loadProfiles(ids) {
    const missing = [...new Set(ids)].filter(id => id && !state.profiles.has(id));
    if (missing.length === 0) return;

    const { data, error } = await db
        .from("profiles")
        .select("id, username, display_name")
        .in("id", missing);

    if (error) {
        console.error("Profiles error:", error);
        return;
    }

    (data || []).forEach(p => state.profiles.set(p.id, p));
}

async function loadServers() {
    const { data, error } = await db
        .from("server_members")
        .select("role, joined_at, servers(id, name, invite_code, owner_id)")
        .eq("user_id", state.me.id)
        .order("joined_at", { ascending: true });

    if (error) {
        console.error("Servers error:", error);
        messageList.replaceChildren(el("div", "list-note", errorText(error)));
        return false;
    }

    state.servers = (data || [])
        .filter(row => row.servers)
        .map(row => ({ ...row.servers, role: row.role }));

    renderRail();
    return true;
}

async function loadChannels() {
    const { data, error } = await db
        .from("channels")
        .select("id, server_id, name, position, created_at")
        .eq("server_id", state.serverId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });

    if (error) {
        console.error("Channels error:", error);
        toast(errorText(error));
        return;
    }

    state.channels = data || [];
}

async function loadMembers() {
    const { data, error } = await db
        .from("server_members")
        .select("user_id, role, joined_at")
        .eq("server_id", state.serverId);

    if (error) {
        console.error("Members error:", error);
        return;
    }

    state.members = data || [];
    await loadProfiles(state.members.map(m => m.user_id));

    // Keep our own cached role in sync with the member list.
    const mine = state.members.find(m => m.user_id === state.me.id);
    const server = currentServer();
    if (server && mine) server.role = mine.role;
}

async function loadMessages() {
    const channelId = state.channelId;
    if (!channelId) return;

    messageList.replaceChildren(el("div", "list-note", "Loading messages…"));

    const { data, error } = await db
        .from("server_messages")
        .select("id, channel_id, user_id, content, attachment_url, attachment_type, attachment_name, created_at")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(100);

    if (channelId !== state.channelId) return; // user switched meanwhile

    if (error) {
        console.error("Messages error:", error);
        messageList.replaceChildren(el("div", "list-note", errorText(error)));
        return;
    }

    const messages = (data || []).reverse();
    await loadProfiles(messages.map(m => m.user_id));

    if (channelId !== state.channelId) return;

    messageList.replaceChildren();

    const channel = currentChannel();
    const intro = el("div", "list-intro");
    intro.append(
        el("h2", "", `Welcome to #${channel?.name || "channel"}`),
        el("p", "", "This is the start of the channel. Say hello — you can share images and GIFs too.")
    );
    messageList.append(intro);

    messages.forEach(m => messageList.append(buildMessage(m)));
    scrollToBottom(true);
}

// ---------------------------------------------------------
// RENDER: rail, channels, members, messages
// ---------------------------------------------------------

function renderRail() {
    const list = $("serverList");
    list.replaceChildren();

    state.servers.forEach(server => {
        const btn = el("button", "rail-btn" + (server.id === state.serverId ? " active" : ""),
            server.name.trim().charAt(0).toUpperCase());
        btn.type = "button";
        btn.title = server.name;
        btn.addEventListener("click", () => selectServer(server.id));
        list.append(btn);
    });
}

function renderChannels() {
    const list = $("channelList");
    list.replaceChildren();

    const canManage = myRank() >= 2;
    $("addChannelBtn").hidden = !canManage;

    state.channels.forEach(channel => {
        const row = el("button", "channel-item" + (channel.id === state.channelId ? " active" : ""));
        row.type = "button";
        row.append(el("span", "hash", "#"), el("span", "name", channel.name));

        row.addEventListener("click", () => {
            selectChannel(channel.id);
            app.classList.remove("channels-open");
        });

        if (canManage && state.channels.length > 1) {
            const del = el("span", "channel-del", "✕");
            del.title = "Delete channel";
            del.setAttribute("role", "button");
            del.addEventListener("click", event => {
                event.stopPropagation();
                deleteChannel(channel);
            });
            row.append(del);
        }

        list.append(row);
    });
}

function renderHeader() {
    const server = currentServer();
    $("serverName").textContent = server ? server.name : "Servers";
    $("serverHeaderBtn").disabled = !server;

    const channel = currentChannel();
    $("chatTitle").textContent = channel ? "# " + channel.name : (server ? server.name : "Welcome");

    messageInput.placeholder = channel ? `Message #${channel.name}` : "Message";
}

function renderMembers() {
    const panel = $("memberList");
    panel.replaceChildren();

    const groups = [
        ["owner", "Owner"],
        ["admin", "Admins"],
        ["moderator", "Moderators"],
        ["member", "Members"]
    ];

    groups.forEach(([role, title]) => {
        const people = state.members
            .filter(m => m.role === role)
            .sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id)));

        if (people.length === 0) return;

        const group = el("div", "member-group");
        group.append(el("div", "member-group-title", `${title} — ${people.length}`));

        people.forEach(member => {
            const manageable = canKick(member) || availableRoles(member).length > 0;
            const row = el("button", "member-row" + (manageable ? " manageable" : ""));
            row.type = "button";

            const text = el("div", "member-text");
            text.append(
                el("strong", "", nameOf(member.user_id) + (member.user_id === state.me.id ? " (you)" : "")),
                el("span", "sub", handleOf(member.user_id))
            );

            row.append(el("div", "avatar", initialOf(member.user_id)), text);

            if (manageable) {
                row.addEventListener("click", event => {
                    event.stopPropagation();
                    showMemberMenu(member, row);
                });
            }

            group.append(row);
        });

        panel.append(group);
    });
}

function renderIdentity() {
    const name = state.myProfile?.display_name || state.myProfile?.username || "You";
    $("meName").textContent = name;
    $("meAvatar").textContent = name.charAt(0).toUpperCase();

    const role = myRole();
    $("meRole").textContent = role ? ROLE_LABEL[role] : " ";
}

function renderServerView() {
    renderRail();
    renderHeader();
    renderChannels();
    renderMembers();
    renderIdentity();
}

// Only http(s) URLs of pictures are ever turned into <img>.
const IMAGE_URL = /^https:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const GIPHY_URL = /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)\/\S+$/i;

function isSafeHttps(url) {
    try {
        return new URL(url).protocol === "https:";
    } catch (_) {
        return false;
    }
}

function linkify(text) {
    const fragment = document.createDocumentFragment();
    const urlPattern = /https:\/\/[^\s<>"']+/g;
    let last = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
        if (match.index > last) fragment.append(text.slice(last, match.index));

        const a = el("a", "", match[0]);
        a.href = match[0];
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        fragment.append(a);

        last = match.index + match[0].length;
    }

    if (last < text.length) fragment.append(text.slice(last));

    return fragment;
}

function makeImage(url, alt) {
    const img = el("img", "msg-image");
    img.src = url;
    img.alt = alt || "Image";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("click", () => openLightbox(url, alt));
    img.addEventListener("error", () => {
        img.replaceWith(el("div", "msg-user", "[image unavailable]"));
    });
    return img;
}

function buildMessage(message) {
    const row = el("div", "msg");
    row.dataset.id = message.id;

    row.append(el("div", "avatar", initialOf(message.user_id)));

    const body = el("div", "msg-body");
    const head = el("div", "msg-head");

    head.append(el("span", "msg-author", nameOf(message.user_id)));

    const role = roleOfUser(message.user_id);
    if (role && role !== "member") {
        head.append(el("span", `role-badge role-${role}`, ROLE_LABEL[role]));
    }

    head.append(
        el("span", "msg-user", handleOf(message.user_id)),
        el("span", "msg-time", formatTime(message.created_at))
    );

    body.append(head);

    const text = (message.content || "").trim();

    // A message that is just a direct image/GIF link shows the picture itself.
    const bareImage = text && !/\s/.test(text) && (IMAGE_URL.test(text) || GIPHY_URL.test(text));

    if (text && !bareImage) {
        const p = el("div", "msg-text");
        p.append(linkify(text));
        body.append(p);
    }

    if (bareImage) {
        body.append(makeImage(text, "Linked image"));
    }

    if (message.attachment_url && isSafeHttps(message.attachment_url)) {
        body.append(makeImage(message.attachment_url, message.attachment_name));
    }

    const canDelete = message.user_id === state.me.id || myRank() >= 1;

    if (canDelete) {
        const del = el("button", "msg-delete", "Delete");
        del.type = "button";
        del.addEventListener("click", () => deleteMessage(message));
        body.append(del);
    }

    row.append(body);
    return row;
}

function scrollToBottom(force = false) {
    const nearBottom =
        messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 160;

    if (force || nearBottom) {
        messageList.scrollTop = messageList.scrollHeight;
    }
}

function openLightbox(url, alt) {
    $("lightboxImg").src = url;
    $("lightboxImg").alt = alt || "Image";
    $("lightbox").hidden = false;
}

$("lightbox").addEventListener("click", closeModals);

// ---------------------------------------------------------
// SELECTING SERVER / CHANNEL
// ---------------------------------------------------------

async function selectServer(serverId, preferredChannel = null) {
    if (!state.servers.some(s => s.id === serverId)) return;

    unsubscribeRealtime();

    state.serverId = serverId;
    state.channelId = null;
    state.channels = [];
    state.members = [];
    clearPending();
    remember("oryn:server", serverId);

    $("emptyState").hidden = true;
    composer.hidden = false;
    messageList.replaceChildren(el("div", "list-note", "Loading…"));

    renderServerView();

    await Promise.all([loadChannels(), loadMembers()]);
    if (serverId !== state.serverId) return;

    const remembered = preferredChannel || recall("oryn:channel:" + serverId);
    const channel = state.channels.find(c => c.id === remembered) || state.channels[0];

    state.channelId = channel ? channel.id : null;
    if (state.channelId) remember("oryn:channel:" + serverId, state.channelId);

    renderServerView();
    updateComposerAccess();
    subscribeRealtime();

    if (state.channelId) {
        await loadMessages();
    } else {
        messageList.replaceChildren(el("div", "list-note", "This server has no channels yet."));
    }
}

async function selectChannel(channelId) {
    if (channelId === state.channelId) return;

    state.channelId = channelId;
    remember("oryn:channel:" + state.serverId, channelId);

    renderHeader();
    renderChannels();
    clearPending();
    await loadMessages();
    messageInput.focus();
}

function updateComposerAccess() {
    composer.hidden = !state.channelId;
}

function showEmptyState() {
    state.serverId = null;
    state.channelId = null;
    state.channels = [];
    state.members = [];

    unsubscribeRealtime();
    renderServerView();

    messageList.replaceChildren();
    composer.hidden = true;
    $("emptyState").hidden = false;
    $("channelList").replaceChildren();
    $("memberList").replaceChildren();
    $("addChannelBtn").hidden = true;
}

// ---------------------------------------------------------
// REALTIME
// ---------------------------------------------------------

function subscribeRealtime() {
    const serverId = state.serverId;
    if (!serverId) return;

    state.realtime = db
        .channel("server-" + serverId)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "server_messages", filter: `server_id=eq.${serverId}` },
            onMessageChange)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "channels", filter: `server_id=eq.${serverId}` },
            onChannelChange)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "server_members", filter: `server_id=eq.${serverId}` },
            onMemberChange)
        .subscribe();
}

function unsubscribeRealtime() {
    if (state.realtime) {
        db.removeChannel(state.realtime);
        state.realtime = null;
    }
}

async function onMessageChange(payload) {
    if (payload.eventType === "INSERT") {
        const message = payload.new;
        if (message.channel_id !== state.channelId) return;
        if (messageList.querySelector(`[data-id="${CSS.escape(message.id)}"]`)) return;

        await loadProfiles([message.user_id]);
        if (message.channel_id !== state.channelId) return;

        const stick = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 160
            || message.user_id === state.me.id;

        messageList.append(buildMessage(message));
        if (stick) scrollToBottom(true);
    }

    if (payload.eventType === "DELETE") {
        const id = payload.old?.id;
        if (!id) return;
        messageList.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
    }
}

async function onChannelChange() {
    const previous = state.channelId;

    await loadChannels();

    if (!state.channels.some(c => c.id === previous)) {
        const next = state.channels[0];
        state.channelId = null;
        renderChannels();
        renderHeader();

        if (next) {
            await selectChannel(next.id);
        } else {
            updateComposerAccess();
            messageList.replaceChildren(el("div", "list-note", "This server has no channels yet."));
        }
        return;
    }

    renderChannels();
    renderHeader();
}

async function onMemberChange(payload) {
    // Did something happen to *me*?
    const affected = payload.new?.user_id || payload.old?.user_id;

    if (payload.eventType === "DELETE" && affected === state.me.id) {
        toast("You were removed from this server.");
        await refreshAfterMembershipLoss();
        return;
    }

    await loadMembers();

    if (affected === state.me.id && payload.eventType === "UPDATE") {
        toast(`Your role is now ${ROLE_LABEL[payload.new.role]}.`);
        // Rebuild message buttons / channel controls for the new rank.
        renderServerView();
        await loadMessages();
        return;
    }

    renderMembers();
}

async function refreshAfterMembershipLoss() {
    await loadServers();

    if (state.servers.length > 0) {
        await selectServer(state.servers[0].id);
    } else {
        showEmptyState();
    }
}

// ---------------------------------------------------------
// SENDING MESSAGES + ATTACHMENTS
// ---------------------------------------------------------

function pickFile(file) {
    if (!file) return;

    if (!FILE_EXTENSIONS[file.type]) {
        toast("Only PNG, JPG, GIF and WebP images are supported.");
        return;
    }

    if (file.size > MAX_FILE_BYTES) {
        toast("That file is too large. The limit is 8 MB.");
        return;
    }

    clearPending();
    state.pendingFile = file;

    const preview = $("attachPreview");
    const url = URL.createObjectURL(file);

    const img = el("img");
    img.src = url;
    img.alt = "Attachment preview";

    const meta = el("div", "meta");
    meta.append(
        el("strong", "", file.name || "pasted-image"),
        el("span", "", `${(file.size / 1024).toFixed(file.size > 1024 * 1024 ? 0 : 1)} KB · ${file.type.replace("image/", "").toUpperCase()}`)
    );

    const remove = el("button", "ghost-btn", "Remove");
    remove.type = "button";
    remove.addEventListener("click", clearPending);

    preview.replaceChildren(img, meta, remove);
    preview.dataset.url = url;
    preview.hidden = false;
}

function clearPending() {
    const preview = $("attachPreview");

    if (preview.dataset.url) {
        URL.revokeObjectURL(preview.dataset.url);
        delete preview.dataset.url;
    }

    preview.replaceChildren();
    preview.hidden = true;
    state.pendingFile = null;
    $("fileInput").value = "";
}

async function uploadAttachment(file) {
    const path = `${state.me.id}/${crypto.randomUUID()}.${FILE_EXTENSIONS[file.type]}`;

    const { error } = await db.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });

    if (error) throw error;

    const { data } = db.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);

    return { url: data.publicUrl, path };
}

async function sendMessage() {
    if (state.sending || !state.channelId) return;

    const content = messageInput.value.trim();
    const file = state.pendingFile;

    if (!content && !file) return;

    state.sending = true;
    $("sendBtn").disabled = true;
    $("sendBtn").textContent = file ? "Uploading…" : "Sending…";

    try {
        const row = {
            server_id: state.serverId,
            channel_id: state.channelId,
            user_id: state.me.id,
            content
        };

        if (file) {
            const uploaded = await uploadAttachment(file);
            row.attachment_url = uploaded.url;
            row.attachment_type = file.type;
            row.attachment_name = (file.name || "image").slice(0, 200);
        }

        const { error } = await db.from("server_messages").insert(row);
        if (error) throw error;

        messageInput.value = "";
        autoGrow();
        clearPending();
    } catch (error) {
        console.error("Send error:", error);
        toast(errorText(error));
    } finally {
        state.sending = false;
        $("sendBtn").disabled = false;
        $("sendBtn").textContent = "Send";
        messageInput.focus();
    }
}

async function deleteMessage(message) {
    if (!confirm("Delete this message?")) return;

    const { error } = await db.from("server_messages").delete().eq("id", message.id);

    if (error) {
        console.error("Delete message error:", error);
        toast(errorText(error));
        return;
    }

    // Realtime removes it too, but do it now in case the socket lags.
    messageList.querySelector(`[data-id="${CSS.escape(message.id)}"]`)?.remove();

    // Best effort: clean up the picture when the author deletes their own message.
    if (message.attachment_url && message.user_id === state.me.id) {
        const marker = `/${ATTACHMENT_BUCKET}/`;
        const index = message.attachment_url.indexOf(marker);
        if (index !== -1) {
            const path = decodeURIComponent(message.attachment_url.slice(index + marker.length).split("?")[0]);
            db.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => {});
        }
    }
}

function autoGrow() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
}

composer.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage();
});

messageInput.addEventListener("input", autoGrow);

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
    }
});

$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", event => pickFile(event.target.files[0]));

// Paste an image or GIF straight into the box.
messageInput.addEventListener("paste", event => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === "file" && i.type.startsWith("image/"));
    if (item) {
        event.preventDefault();
        pickFile(item.getAsFile());
    }
});

// Drag and drop onto the composer / chat.
["dragenter", "dragover"].forEach(type => {
    document.querySelector(".srv-chat").addEventListener(type, event => {
        if (!state.channelId) return;
        if ([...(event.dataTransfer?.types || [])].includes("Files")) {
            event.preventDefault();
            composer.classList.add("drag");
        }
    });
});

["dragleave", "drop"].forEach(type => {
    document.querySelector(".srv-chat").addEventListener(type, event => {
        if (type === "drop") {
            event.preventDefault();
            pickFile(event.dataTransfer?.files?.[0]);
        }
        composer.classList.remove("drag");
    });
});

// ---------------------------------------------------------
// ROLES: permissions and member menu
// ---------------------------------------------------------

function canKick(target) {
    return target.user_id !== state.me.id
        && myRank() >= 1
        && rankOf(target.role) < myRank();
}

// Roles I may assign to this member (admins: moderator/member, owner: + admin)
function availableRoles(target) {
    if (target.user_id === state.me.id) return [];
    if (myRank() < 2 || rankOf(target.role) >= myRank()) return [];

    return ["admin", "moderator", "member"].filter(role =>
        role !== target.role && rankOf(role) < myRank()
    );
}

function hideMemberMenu() {
    const menu = $("memberMenu");
    menu.hidden = true;
    menu.replaceChildren();
}

function showMemberMenu(member, anchor) {
    const menu = $("memberMenu");
    menu.replaceChildren();

    menu.append(el("div", "menu-head", `${nameOf(member.user_id)} · ${ROLE_LABEL[member.role]}`));

    availableRoles(member).forEach(role => {
        const verb = rankOf(role) > rankOf(member.role) ? "Promote to" : "Set as";
        const btn = el("button", "", `${verb} ${ROLE_LABEL[role]}`);
        btn.type = "button";
        btn.addEventListener("click", () => changeRole(member, role));
        menu.append(btn);
    });

    if (canKick(member)) {
        const kick = el("button", "danger", "Remove from server");
        kick.type = "button";
        kick.addEventListener("click", () => kickMember(member));
        menu.append(kick);
    }

    menu.hidden = false;

    const box = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;

    let left = box.left - width - 8;
    if (left < 8) left = Math.min(box.right + 8, window.innerWidth - width - 8);

    const top = Math.min(box.top, window.innerHeight - height - 8);

    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = Math.max(8, top) + "px";
}

document.addEventListener("click", event => {
    if (!$("memberMenu").contains(event.target)) hideMemberMenu();
});

async function changeRole(member, role) {
    hideMemberMenu();

    const { error } = await db.rpc("set_member_role", {
        p_server: state.serverId,
        p_user: member.user_id,
        p_role: role
    });

    if (error) {
        console.error("Role error:", error);
        toast(errorText(error));
        return;
    }

    toast(`${nameOf(member.user_id)} is now ${ROLE_LABEL[role]}.`);
    await loadMembers();
    renderMembers();
}

async function kickMember(member) {
    hideMemberMenu();

    if (!confirm(`Remove ${nameOf(member.user_id)} from this server?`)) return;

    const { error } = await db.rpc("kick_member", {
        p_server: state.serverId,
        p_user: member.user_id
    });

    if (error) {
        console.error("Kick error:", error);
        toast(errorText(error));
        return;
    }

    toast(`${nameOf(member.user_id)} was removed.`);
    await loadMembers();
    renderMembers();
}

// ---------------------------------------------------------
// SERVER ACTIONS: create, join, channels, settings
// ---------------------------------------------------------

function openAddServer(tab = "create") {
    setTab(tab);
    openModal("serverModal");
}

function setTab(tab) {
    document.querySelectorAll("#serverModal .modal-tabs button").forEach(b => {
        b.classList.toggle("active", b.dataset.tab === tab);
    });

    document.querySelectorAll("#serverModal [data-panel]").forEach(panel => {
        panel.hidden = panel.dataset.panel !== tab;
    });

    $("serverModal").querySelectorAll("[data-error]").forEach(n => { n.textContent = ""; });

    const focusId = tab === "create" ? "newServerName" : "inviteCode";
    setTimeout(() => $(focusId).focus(), 30);
}

document.querySelectorAll("#serverModal .modal-tabs button").forEach(btn => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

$("addServerBtn").addEventListener("click", () => openAddServer());
$("emptyAddBtn").addEventListener("click", () => openAddServer());

$("createServerForm").addEventListener("submit", async event => {
    event.preventDefault();

    const input = $("newServerName");
    const button = event.target.querySelector("button[type='submit']");
    button.disabled = true;

    const { data, error } = await db.rpc("create_server", { p_name: input.value });

    button.disabled = false;

    if (error) {
        setModalError("serverModal", errorText(error));
        return;
    }

    input.value = "";
    closeModals();
    await loadServers();
    await selectServer(data);
    toast("Server created. You're the owner.");
});

$("joinServerForm").addEventListener("submit", async event => {
    event.preventDefault();

    const input = $("inviteCode");
    const button = event.target.querySelector("button[type='submit']");
    button.disabled = true;

    const { data, error } = await db.rpc("join_server", { p_code: input.value });

    button.disabled = false;

    if (error) {
        setModalError("serverModal", errorText(error));
        return;
    }

    input.value = "";
    closeModals();
    await loadServers();
    await selectServer(data);
    toast("Joined server.");
});

$("addChannelBtn").addEventListener("click", () => {
    $("newChannelName").value = "";
    openModal("channelModal");
});

$("createChannelForm").addEventListener("submit", async event => {
    event.preventDefault();

    const name = $("newChannelName").value
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 32);

    if (!name) {
        setModalError("channelModal", "Use letters, numbers or dashes.");
        return;
    }

    const { data, error } = await db
        .from("channels")
        .insert({
            server_id: state.serverId,
            name,
            position: state.channels.length
        })
        .select("id")
        .single();

    if (error) {
        setModalError(
            "channelModal",
            error.code === "23505" ? "A channel with that name already exists." : errorText(error)
        );
        return;
    }

    closeModals();
    await loadChannels();
    renderChannels();
    await selectChannel(data.id);
});

async function deleteChannel(channel) {
    if (!confirm(`Delete #${channel.name} and all its messages?`)) return;

    const { error } = await db.from("channels").delete().eq("id", channel.id);

    if (error) {
        console.error("Delete channel error:", error);
        toast(errorText(error));
        return;
    }

    // Realtime also fires; refresh locally so it feels instant.
    await onChannelChange();
}

// ----- settings -----

$("serverHeaderBtn").addEventListener("click", () => {
    const server = currentServer();
    if (!server) return;

    const rank = myRank();

    $("inviteDisplay").textContent = server.invite_code;
    $("resetInviteBtn").hidden = rank < 2;
    $("renameServerForm").hidden = rank < 2;
    $("renameServerInput").value = server.name;
    $("leaveServerBtn").hidden = rank === 3;
    $("deleteServerBtn").hidden = rank !== 3;
    $("settingsTitle").textContent = server.name;

    openModal("settingsModal");
});

$("copyInviteBtn").addEventListener("click", async () => {
    const code = $("inviteDisplay").textContent;

    try {
        await navigator.clipboard.writeText(code);
        toast("Invite code copied.");
    } catch (_) {
        toast("Copy failed — select the code manually.");
    }
});

$("resetInviteBtn").addEventListener("click", async () => {
    if (!confirm("Reset the invite code? The old code will stop working.")) return;

    const { data, error } = await db.rpc("reset_invite_code", { p_server: state.serverId });

    if (error) {
        setModalError("settingsModal", errorText(error));
        return;
    }

    currentServer().invite_code = data;
    $("inviteDisplay").textContent = data;
    toast("New invite code created.");
});

$("renameServerForm").addEventListener("submit", async event => {
    event.preventDefault();

    const name = $("renameServerInput").value.trim();
    if (name.length < 2) return;

    const { error } = await db.from("servers").update({ name }).eq("id", state.serverId);

    if (error) {
        setModalError("settingsModal", errorText(error));
        return;
    }

    currentServer().name = name;
    renderServerView();
    $("settingsTitle").textContent = name;
    toast("Server renamed.");
});

$("leaveServerBtn").addEventListener("click", async () => {
    if (!confirm("Leave this server?")) return;

    const { error } = await db.rpc("leave_server", { p_server: state.serverId });

    if (error) {
        setModalError("settingsModal", errorText(error));
        return;
    }

    closeModals();
    await refreshAfterMembershipLoss();
});

$("deleteServerBtn").addEventListener("click", async () => {
    const server = currentServer();
    const typed = prompt(`This permanently deletes "${server.name}", its channels and messages.\nType the server name to confirm:`);

    if (typed === null) return;

    if (typed.trim() !== server.name) {
        setModalError("settingsModal", "That name didn't match — nothing was deleted.");
        return;
    }

    const { error } = await db.from("servers").delete().eq("id", server.id);

    if (error) {
        setModalError("settingsModal", errorText(error));
        return;
    }

    closeModals();
    toast("Server deleted.");
    await refreshAfterMembershipLoss();
});

// ---------------------------------------------------------
// LAYOUT TOGGLES (mobile)
// ---------------------------------------------------------

$("membersToggle").addEventListener("click", () => {
    if (window.matchMedia("(max-width: 1000px)").matches) {
        app.classList.toggle("members-open");
    } else {
        app.classList.toggle("members-hidden");
    }
});

$("channelsToggle").addEventListener("click", event => {
    event.stopPropagation();
    app.classList.toggle("channels-open");
});

document.addEventListener("click", event => {
    if (!event.target.closest(".srv-members") && !event.target.closest("#membersToggle")) {
        app.classList.remove("members-open");
    }
    if (!event.target.closest(".srv-channels") && !event.target.closest("#channelsToggle")) {
        app.classList.remove("channels-open");
    }
});

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------

async function init() {
    if (!db) {
        messageList.replaceChildren(el("div", "list-note", "Supabase is not connected."));
        return;
    }

    const { data, error } = await db.auth.getUser();

    if (error || !data.user) {
        window.location.replace("login.html");
        return;
    }

    state.me = data.user;

    await loadProfiles([state.me.id]);
    state.myProfile = state.profiles.get(state.me.id) || null;
    renderIdentity();

    const ok = await loadServers();
    if (!ok) return;

    if (state.servers.length === 0) {
        showEmptyState();
        return;
    }

    const saved = recall("oryn:server");
    const first = state.servers.find(s => s.id === saved) || state.servers[0];

    await selectServer(first.id);
}

init();
