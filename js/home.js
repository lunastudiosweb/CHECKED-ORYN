
const client = window.supabaseClient;

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

async function initializeHome() {
    if (!client) {
        console.error("Supabase client is missing.");
        return;
    }

    const { data, error } = await client.auth.getUser();

    if (error || !data.user) {
        window.location.replace("login.html");
        return;
    }

    const user = data.user;

    const { data: profile, error: profileError } = await client
        .from("profiles")
        .select("username, display_name")
        .eq("id", user.id)
        .maybeSingle();

    if (profileError) {
        console.error("Profile loading error:", profileError);
    }

    const username = profile?.username || "user";
    const displayName = profile?.display_name || username;
    const initial = displayName.charAt(0).toUpperCase();

    document.getElementById("welcomeName").textContent = displayName;
    document.getElementById("profileDisplayName").textContent = displayName;
    document.getElementById("profileUsername").textContent = "@" + username;
    document.getElementById("profileUsernameDetail").textContent = username;
    document.getElementById("profileEmail").textContent =
        user.email || "Not available";

    document.getElementById("headerAvatar").textContent = initial;
    document.getElementById("profileAvatar").textContent = initial;
    document.getElementById("composerAvatar").textContent = initial;
}

const logoutButton = document.getElementById("logoutButton");

if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
        logoutButton.disabled = true;
        logoutButton.textContent = "Logging out...";

        const { error } = await client.auth.signOut();

        if (error) {
            console.error("Logout error:", error);

            logoutButton.disabled = false;
            logoutButton.textContent = "Log out";

            alert("Could not log out. Please try again.");
            return;
        }

        window.location.replace("login.html");
    });
}

initializeHome();
