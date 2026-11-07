
const client = window.supabaseClient;

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

async function initializeHome() {
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

    const name = profile?.display_name || profile?.username || "there";

    const welcomeName = document.getElementById("welcomeName");
    const profileUsername = document.getElementById("profileUsername");
    const profileEmail = document.getElementById("profileEmail");

    if (welcomeName) welcomeName.textContent = name;
    if (profileUsername) profileUsername.textContent = profile?.username || "Not available";
    if (profileEmail) profileEmail.textContent = user.email || "Not available";
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
            return;
        }

        window.location.replace("login.html");
    });
}

if (document.getElementById("welcomeName")) {
    initializeHome();
}
