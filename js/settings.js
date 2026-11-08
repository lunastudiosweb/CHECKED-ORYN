// =========================================================
// CHECKED ORYN — Settings
// Profile, email, password, sessions, account deletion.
// Needs supabase/settings.sql run once (profile edits + delete).
// =========================================================

const db = window.supabaseClient;

const $ = id => document.getElementById(id);

const state = { user: null, profile: null };

$("year").textContent = new Date().getFullYear();

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function say(id, text, type = "") {
    const node = $(id);
    node.textContent = text;
    node.className = "set-msg" + (type ? " " + type : "");
}

function busy(button, isBusy, label) {
    button.disabled = isBusy;
    if (label) button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = isBusy && label ? label : (button.dataset.label || button.textContent);
}

function friendly(error) {
    const text = error?.message || "Something went wrong.";

    if (/rate limit|too many/i.test(text)) return "Too many attempts. Please wait a bit and try again.";
    if (/same password/i.test(text)) return "Your new password must be different from the current one.";
    if (/already (been )?registered|already exists/i.test(text)) return "That email is already in use.";
    if (/Could not find the function/i.test(text)) return "Run supabase/settings.sql in the Supabase SQL Editor first.";

    return text;
}

function refreshIdentity() {
    const name = state.profile?.display_name || state.profile?.username || "?";
    const url = state.profile?.avatar_url;

    [$("headerAvatar"), $("avatarPreview")].forEach(node => {
        node.classList.toggle("has-image", Boolean(url));
        node.style.backgroundImage = url ? `url("${url.replace(/"/g, "%22")}")` : "";
        node.textContent = url ? "" : name.charAt(0).toUpperCase();
    });

    $("avatarRemove").hidden = !url;
}

// ---------------------------------------------------------
// PROFILE
// ---------------------------------------------------------

$("profileForm").addEventListener("submit", async event => {
    event.preventDefault();

    const button = $("profileSave");
    const displayName = $("displayName").value.trim();
    const username = $("username").value.trim();

    $("displayName").classList.remove("invalid");
    $("username").classList.remove("invalid");

    if (displayName.length < 1 || displayName.length > 40) {
        $("displayName").classList.add("invalid");
        say("profileMsg", "Display name must be 1–40 characters.", "error");
        return;
    }

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        $("username").classList.add("invalid");
        say("profileMsg", "Username must be 3–24 letters, numbers or underscores.", "error");
        return;
    }

    if (displayName === state.profile.display_name && username === state.profile.username) {
        say("profileMsg", "Nothing to change.", "");
        return;
    }

    busy(button, true, "Saving…");
    say("profileMsg", "");

    try {
        if (username.toLowerCase() !== (state.profile.username || "").toLowerCase()) {
            const { data: taken, error: lookupError } = await db
                .from("profiles")
                .select("id")
                .ilike("username", username)
                .neq("id", state.user.id)
                .limit(1);

            if (lookupError) throw lookupError;

            if (taken && taken.length > 0) {
                $("username").classList.add("invalid");
                say("profileMsg", "That username is already taken.", "error");
                return;
            }
        }

        const { data, error } = await db
            .from("profiles")
            .update({ username, display_name: displayName })
            .eq("id", state.user.id)
            .select("id, username, display_name, avatar_url");

        if (error) {
            if (error.code === "23505") {
                $("username").classList.add("invalid");
                say("profileMsg", "That username is already taken.", "error");
                return;
            }
            throw error;
        }

        // RLS blocks silently: zero rows updated means the policy is missing.
        if (!data || data.length === 0) {
            say("profileMsg", "Couldn't save. Run supabase/settings.sql in the Supabase SQL Editor.", "error");
            return;
        }

        state.profile = data[0];
        refreshIdentity();

        // Keep the sign-in metadata in step (best effort).
        db.auth.updateUser({ data: { username, display_name: displayName } }).catch(() => {});

        say("profileMsg", "Profile saved.", "success");
    } catch (error) {
        console.error("Profile save error:", error);
        say("profileMsg", friendly(error), "error");
    } finally {
        busy(button, false);
    }
});

// ---------------------------------------------------------
// PROFILE PICTURE
// Cropped to a centred square and shrunk to 256px in the browser,
// so uploads are small and every avatar is the same shape.
// ---------------------------------------------------------

const AVATAR_BUCKET = "avatars";
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE = 256;

async function squareAvatar(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIZE;

    canvas.getContext("2d").drawImage(
        bitmap,
        (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
        0, 0, AVATAR_SIZE, AVATAR_SIZE
    );

    bitmap.close?.();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new Error("Couldn't process that image.");

    return blob;
}

function storagePathFromUrl(url) {
    const marker = `/${AVATAR_BUCKET}/`;
    const index = (url || "").indexOf(marker);
    return index === -1 ? null : decodeURIComponent(url.slice(index + marker.length).split("?")[0]);
}

async function saveAvatarUrl(url) {
    const { data, error } = await db
        .from("profiles")
        .update({ avatar_url: url })
        .eq("id", state.user.id)
        .select("id");

    if (error) throw error;

    if (!data || data.length === 0) {
        throw new Error("Couldn't save. Run supabase/avatars.sql and supabase/settings.sql in the SQL Editor.");
    }

    state.profile.avatar_url = url;
    refreshIdentity();
}

$("avatarChoose").addEventListener("click", () => $("avatarFile").click());

$("avatarFile").addEventListener("change", async event => {
    const file = event.target.files[0];
    event.target.value = "";

    if (!file) return;

    if (!AVATAR_TYPES.includes(file.type)) {
        say("avatarMsg", "Use a PNG, JPG, WebP or GIF image.", "error");
        return;
    }

    if (file.size > AVATAR_MAX_BYTES) {
        say("avatarMsg", "That image is too large (5 MB max).", "error");
        return;
    }

    const button = $("avatarChoose");
    busy(button, true, "Uploading…");
    say("avatarMsg", "");

    try {
        const blob = await squareAvatar(file);
        const path = `${state.user.id}/${Date.now()}.webp`;

        const { error } = await db.storage
            .from(AVATAR_BUCKET)
            .upload(path, blob, { contentType: blob.type, cacheControl: "31536000", upsert: false });

        if (error) throw error;

        const oldPath = storagePathFromUrl(state.profile.avatar_url);
        const url = db.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

        await saveAvatarUrl(url);

        if (oldPath) db.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});

        say("avatarMsg", "Profile picture updated.", "success");
    } catch (error) {
        console.error("Avatar error:", error);
        say("avatarMsg", friendly(error), "error");
    } finally {
        busy(button, false);
    }
});

$("avatarRemove").addEventListener("click", async () => {
    const oldPath = storagePathFromUrl(state.profile.avatar_url);

    try {
        await saveAvatarUrl(null);
        if (oldPath) db.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
        say("avatarMsg", "Profile picture removed.", "success");
    } catch (error) {
        console.error("Avatar remove error:", error);
        say("avatarMsg", friendly(error), "error");
    }
});

// ---------------------------------------------------------
// EMAIL
// ---------------------------------------------------------

$("emailForm").addEventListener("submit", async event => {
    event.preventDefault();

    const button = $("emailSave");
    const email = $("email").value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        say("emailMsg", "Enter a valid email address.", "error");
        return;
    }

    if (email.toLowerCase() === (state.user.email || "").toLowerCase()) {
        say("emailMsg", "That's already your email.", "");
        return;
    }

    busy(button, true, "Updating…");
    say("emailMsg", "");

    const { error } = await db.auth.updateUser({ email });

    busy(button, false);

    if (error) {
        console.error("Email error:", error);
        say("emailMsg", friendly(error), "error");
        return;
    }

    say("emailMsg", "Check your inbox — confirm the link we sent to finish the change.", "success");
});

// ---------------------------------------------------------
// PASSWORD
// ---------------------------------------------------------

$("passwordForm").addEventListener("submit", async event => {
    event.preventDefault();

    const button = $("passwordSave");
    const current = $("currentPassword").value;
    const next = $("newPassword").value;
    const confirm = $("confirmPassword").value;

    if (!current) {
        say("passwordMsg", "Enter your current password.", "error");
        return;
    }

    if (next.length < 8) {
        say("passwordMsg", "New password must be at least 8 characters.", "error");
        return;
    }

    if (next !== confirm) {
        say("passwordMsg", "New passwords don't match.", "error");
        return;
    }

    if (next === current) {
        say("passwordMsg", "Your new password must be different.", "error");
        return;
    }

    busy(button, true, "Changing…");
    say("passwordMsg", "");

    // Prove it's really the owner before changing anything.
    const { error: verifyError } = await db.auth.signInWithPassword({
        email: state.user.email,
        password: current
    });

    if (verifyError) {
        busy(button, false);
        say("passwordMsg", "Current password is incorrect.", "error");
        return;
    }

    const { error } = await db.auth.updateUser({ password: next });

    busy(button, false);

    if (error) {
        console.error("Password error:", error);
        say("passwordMsg", friendly(error), "error");
        return;
    }

    $("passwordForm").reset();
    say("passwordMsg", "Password changed.", "success");
});

// ---------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------

async function signOut(scope, button) {
    button.disabled = true;
    say("sessionMsg", "Logging out…");

    const { error } = await db.auth.signOut({ scope });

    if (error) {
        console.error("Logout error:", error);
        button.disabled = false;
        say("sessionMsg", friendly(error), "error");
        return;
    }

    window.location.replace("login.html");
}

$("logoutButton").addEventListener("click", () => signOut("local", $("logoutButton")));

$("logoutAllButton").addEventListener("click", () => {
    if (!confirm("Log out on every device, including this one?")) return;
    signOut("global", $("logoutAllButton"));
});

// ---------------------------------------------------------
// DELETE ACCOUNT
// ---------------------------------------------------------

const deleteInput = $("deleteConfirm");
const deleteButton = $("deleteSave");

deleteButton.disabled = true;

deleteInput.addEventListener("input", () => {
    deleteButton.disabled =
        deleteInput.value.trim().toLowerCase() !== (state.profile?.username || "").toLowerCase()
        || !state.profile?.username;
});

$("deleteForm").addEventListener("submit", async event => {
    event.preventDefault();

    if (deleteButton.disabled) return;
    if (!confirm("This permanently deletes your account. Continue?")) return;

    busy(deleteButton, true, "Deleting…");
    say("deleteMsg", "");

    const { error } = await db.rpc("delete_my_account");

    if (error) {
        console.error("Delete account error:", error);
        busy(deleteButton, false);
        say("deleteMsg", friendly(error), "error");
        return;
    }

    await db.auth.signOut().catch(() => {});
    window.location.replace("index.html");
});

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------

async function init() {
    if (!db) {
        say("profileMsg", "Supabase is not connected.", "error");
        return;
    }

    const { data, error } = await db.auth.getUser();

    if (error || !data.user) {
        window.location.replace("login.html");
        return;
    }

    state.user = data.user;
    $("email").value = data.user.email || "";

    const { data: profile, error: profileError } = await db
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .eq("id", data.user.id)
        .maybeSingle();

    if (profileError) {
        console.error("Profile loading error:", profileError);
        say("profileMsg", "Couldn't load your profile.", "error");
    }

    state.profile = profile || { id: data.user.id, username: "", display_name: "" };

    $("displayName").value = state.profile.display_name || "";
    $("username").value = state.profile.username || "";
    refreshIdentity();
}

init();
