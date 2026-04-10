import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const { code, redirect_uri, project_id, user_email } = await req.json()

    if (!code || !redirect_uri || !project_id || !user_email) {
      return new Response(
        JSON.stringify({ error: 'Parâmetros obrigatórios ausentes' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Trocar o code por tokens usando o client_secret (seguro aqui no servidor)
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID'),
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET'),
        redirect_uri,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('Token exchange failed:', tokens)
      return new Response(
        JSON.stringify({ error: tokens.error_description || 'Falha na troca de tokens' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Salvar no Supabase usando service role
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()

    await supabaseAdmin.from('project_auth').upsert({
      project_id,
      user_email,
      youtube_access_token: tokens.access_token,
      youtube_refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' })

    return new Response(
      JSON.stringify({
        access_token: tokens.access_token,
        expires_at: expiresAt,
      }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
