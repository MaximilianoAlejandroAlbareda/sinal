'use strict'

const { startServer } = require('./signaling')

const requested = Number(process.env.PORT)
// Em produção (Render, VPS) o proxy alcança o processo por outra interface, então
// o padrão é escutar em todas elas; HOST permite restringir quando necessário.
const host = process.env.HOST || '0.0.0.0'

startServer({ port: Number.isInteger(requested) && requested > 0 ? requested : 8787, host })
  .then(({ port, host: bound }) => {
    console.log(`Sinal rodando em http://${bound}:${port}`)
  })
  .catch((err) => {
    console.error('Não foi possível iniciar o servidor:', err.message)
    process.exit(1)
  })
