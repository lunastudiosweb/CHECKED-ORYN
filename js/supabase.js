
const SUPABASE_URL = "https://jqrluhlivxfjemshwqip.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_yOc_Eecqv7s_zsxW7WYVlw_8gj-iIxZ";

const { createClient } = supabase;

window.supabaseClient = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

console.log("CHECKED ORYN: Supabase connected!");
