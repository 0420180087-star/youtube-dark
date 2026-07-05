import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const getCorsHeaders = (req: Request) => {
  const origin = req.headers.get('origin') ?? ''
  const allowed = Deno.env.get('ALLOWED_ORIGIN') ?? ''
  const allowOrigin = !allowed || allowed === '*' ? '*'
    : origin === allowed ? origin
    : 'null'

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

serve(async (req) => {
  const CORS = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: CORS })
  }

  try {
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID')

    if (!clientId) {
      return new Response(
        JSON.stringify({ 
          error: 'Google Client ID não encontrado. Configure GOOGLE_CLIENT_ID nas secrets.',
          needsSetup: true 
        }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ client_id: clientId }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    )
  }
})