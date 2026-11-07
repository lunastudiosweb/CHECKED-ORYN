
const registerForm = document.getElementById("registerForm");

const registerMessage = document.getElementById("registerMessage");
const registerButton = document.getElementById("registerButton");

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

function showAuthMessage(message, type) {
    registerMessage.textContent = message;
    registerMessage.className = `message show ${type}`;
}

if (registerForm) {
    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const username = document
            .getElementById("username")
            .value.trim();

        const email = document
            .getElementById("email")
            .value.trim();

        const password = document
            .getElementById("password")
            .value;

        const confirmPassword = document
            .getElementById("confirmPassword")
            .value;

        registerMessage.className = "message";

        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
            showAuthMessage(
                "Username must be 3–24 characters and contain only letters, numbers or underscores.",
                "error"
            );
            return;
        }

        if (password.length < 8) {
            showAuthMessage(
                "Your password must contain at least 8 characters.",
                "error"
            );
            return;
        }

        if (password !== confirmPassword) {
            showAuthMessage(
                "Your passwords do not match.",
                "error"
            );
            return;
        }

        registerButton.disabled = true;
        registerButton.textContent = "Creating account...";

        try {
            const client = window.supabaseClient;

            if (!client) {
                throw new Error("Supabase is not initialized.");
            }

            // Check whether the username is already taken.
            const { data: existingUser, error: lookupError } =
                await client
                    .from("profiles")
                    .select("id")
                    .ilike("username", username)
                    .maybeSingle();

            if (lookupError) {
                throw lookupError;
            }

            if (existingUser) {
                showAuthMessage(
                    "That username is already taken. Try another one.",
                    "error"
                );
                return;
            }

            // Create the Supabase account.
            const { data, error } = await client.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        username: username,
                        display_name: username
                    }
                }
            });

            if (error) {
                throw error;
            }

            if (data.session) {
                showAuthMessage(
                    "Your account has been created! Redirecting...",
                    "success"
                );

                setTimeout(() => {
                    window.location.href = "home.html";
                }, 1200);
            } else {
                showAuthMessage(
                    "Account created! Check your email for the confirmation link. After confirming, you can log in.",
                    "success"
                );
            }

            registerForm.reset();

        } catch (error) {
            console.error("Registration error:", error);

            showAuthMessage(
                error.message || "Something went wrong. Please try again.",
                "error"
            );

        } finally {
            registerButton.disabled = false;
            registerButton.innerHTML =
                'Create account <span>→</span>';
        }
    });
}
