require('node-cjsx').transform()
import Hapi from 'hapi'
import Boom from 'boom'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import webpack from 'webpack'
import Negotiator from 'negotiator'
import parsePath from 'parse-filepath'
import find from 'lodash/find'
import webpackRequire from 'webpack-require'
import WebpackPlugin from 'hapi-webpack-plugin'
import opn from 'opn'
import fs from 'fs'
import glob from 'glob'

import globPages from './glob-pages'
import webpackConfig from './webpack.config'
const debug = require('debug')('gatsby:application')

module.exports = (program) => {
  const directory = program.directory

  // Load pages for the site.
  return globPages(directory, (err, pages) => {
    const compilerConfig = webpackConfig(program, directory, 'develop', program.port)

    const compiler = webpack(compilerConfig.resolve())

    let HTMLPath = `${directory}/html`
    // Check if we can't find an html component in root of site.
    if (glob.sync(`${HTMLPath}.*`).length === 0) {
      HTMLPath = '../isomorphic/html'
    }

    const htmlCompilerConfig = webpackConfig(program, directory, 'develop-html', program.port)

    webpackRequire(htmlCompilerConfig.resolve(), require.resolve(HTMLPath), (error, factory) => {
      if (error) {
        console.log(`Failed to require ${directory}/html.js`)
        error.forEach((e) => {
          console.log(e)
        })
        process.exit()
      }
      const HTML = factory()
      debug('Configuring develop server')

      // Setup and start Hapi to serve html + static files + webpack-hot-middleware.
      const server = new Hapi.Server()
      server.connection({
        host: program.host,
        port: program.port,
      })

      server.route({
        method: 'GET',
        path: '/html/{path*}',
        handler: (request, reply) => {
          if (request.path === 'favicon.ico') {
            return reply(Boom.notFound())
          }

          try {
            const htmlElement = React.createElement(
              HTML, {
                body: '',
              }
            )
            let html = ReactDOMServer.renderToStaticMarkup(htmlElement)
            html = `<!DOCTYPE html>\n${html}`
            return reply(html)
          } catch (e) {
            console.log(e.stack)
            throw e
          }
        },
      })

      server.route({
        method: 'GET',
        path: '/{path*}',
        handler: {
          directory: {
            path: `${directory}/pages`,
            listing: false,
            index: false,
          },
        },
      })

      server.ext('onRequest', (request, reply) => {
        const negotiator = new Negotiator(request.raw.req)

        // Try to map the url path to match an actual path of a file on disk.
        const parsed = parsePath(request.path)
        const page = find(pages, (p) => p.path === (`${parsed.dirname}/`))

        let absolutePath = `${directory}/pages`
        let path
        if (page) {
          path = `/${parsePath(page.requirePath).dirname}/${parsed.basename}`
          absolutePath += `/${parsePath(page.requirePath).dirname}/${parsed.basename}`
        } else {
          path = request.path
          absolutePath += request.path
        }
        let isFile = false
        try {
          isFile = fs.lstatSync(absolutePath).isFile()
        } catch (e) {
          // Ignore.
        }

        // If the path matches a file, return that.
        if (isFile) {
          request.setUrl(path)
          reply.continue()
        // Let people load the bundle.js directly.
        } else if (request.path === '/bundle.js') {
          reply.continue()
        } else if (negotiator.mediaType() === 'text/html') {
          request.setUrl(`/html${request.path}`)
          reply.continue()
        } else {
          reply.continue()
        }
      })

      const assets = {
        noInfo: true,
        reload: true,
        publicPath: compilerConfig._config.output.publicPath,
      }
      const hot = {
        hot: true,
        quiet: true,
        noInfo: true,
        host: program.host,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
        stats: {
          colors: true,
        },
      }

      server.register({
        register: WebpackPlugin,
        options: {
          compiler,
          assets,
          hot,
        },
      }, (er) => {
        if (er) {
          console.log(er)
          process.exit()
        }

        server.start((e) => {
          if (e) {
            if (e.code === 'EADDRINUSE') {
              const finder = require('process-finder')
              finder.find({ elevate: false, port: program.port }, (startErr, pids) => {
                const msg =
`We were unable to start Gatsby on port ${program.port} as there's already a process
listening on that port (PID: ${pids[0]}). You can either use a different port
(e.g. gatsby develop --port ${parseInt(program.port, 10) + 1}) or stop the process already listening
on your desired port.`
                console.log(msg)
                process.exit()
              })
            } else {
              console.log(e)
              process.exit()
            }
          } else {
            if (program.open) {
              opn(server.info.uri)
            }
            console.log('Listening at:', server.info.uri)
          }
        })
      })
    })
  })
}
