/* jshint node:true */

var gulp = require( 'gulp' ),
  path = require( 'path' ),
  copy = require( 'gulp-copy' ),
  notify = require( 'gulp-notify' ),
  uglifycss = require( 'gulp-uglifycss' ),
  uglify = require( 'gulp-uglify' ),
  fs = require( 'fs' ),
  plumber = require( 'gulp-plumber' ),
  sourcemaps = require( 'gulp-sourcemaps' ),
  zip = require( 'gulp-zip' ),
  concat = require( 'gulp-concat' );

var manifest = require( './manifest.json' ),
  popupJS = [
    'lib/controller_communicator.js',
    'lib/utils.js',
    'popup.js'
  ],
  optionsCSS = [ 'chrome-bootstrap.css', 'options.css' ],
  optionsJS = [
    'lib/jsrender.min.js',
    'lib/utils.js',
    'lib/controller_communicator.js',
    'options.js'
  ],
  contentJS = manifest.content_scripts[0].js,
  contentCSS = manifest.content_scripts[0].css;

function buildCSS( src, destFile ) {
  return gulp.src( src )
    .pipe( uglifycss( { uglyComments: true } ) )
    .pipe( concat( destFile ) )
    .pipe( gulp.dest( './build/' ) )
    .pipe( notify( {
      title: 'Gulp',
      message: 'Built ' + destFile,
      onLast: true
    } ) );
}

function buildJS ( src, destFile ) {
  return gulp.src( src )
    .pipe( plumber( {
      errorHandler: notify.onError( function ( error ) {
        return error.name + ': ' + error.message + '\n' + error.cause.filename + '[' + error.cause.line + ':' + error.cause.col + '] ' + error.cause.message;
      } )
    } ) )
    .pipe( sourcemaps.init() )
    .pipe( uglify() )
    .pipe( plumber.stop() )
    .pipe( concat( destFile ) )
    .pipe( sourcemaps.write( 'maps' ) )
    .pipe( gulp.dest( './build/' ) )
    .pipe( notify( {
      title: 'Gulp',
      message: 'Built: ' + destFile,
      onLast: true
    } ) );
}

function copyProjectFiles ( ) {
  delete require.cache[ path.resolve( './manifest.json' ) ];
  var manifest = require( './manifest.json' );
  manifest.content_scripts[ 0 ].css = [ 'content.min.css' ];
  manifest.content_scripts[ 0 ].js = [ 'content.min.js' ];
  manifest.background.service_worker = 'background.min.js';

  if ( !fs.existsSync( './build' ) ) {
    fs.mkdirSync( './build' );
  }
  fs.writeFileSync( './build/manifest.json', JSON.stringify( manifest, null, 2 ) );

  return gulp.src( [
    'README.md',
    './images/**/*',
    './_locales/**/*',
    'options.html',
    'popup.html',
    './lib/images/**/*'
  ] )
    .pipe( copy( './build/' ) )
    .pipe( gulp.dest( './' ) )
    .pipe( notify( {
      title: 'Gulp',
      message: 'Copied project files',
      onLast: true
    } ) );
}

function package () {

  return gulp.src( 'build/**/*' )
    .pipe( zip( 'DelugeFlow-' + require( './build/manifest.json' ).version + '.zip' ) )
    .pipe( gulp.dest( 'dist' ) )
    .pipe( notify( {
      title: 'Gulp',
      message: 'Packaged...',
      onLast: true
    } ) );

}

function buildContentCSS () {
  return buildCSS( contentCSS, 'content.min.css' )
}

function buildContentJS () {
  return buildJS( contentJS, 'content.min.js' )
}

function buildOptionsJS () {
  return buildJS( optionsJS, 'options.min.js' )
}

function buildOptionsCSS () {
  return buildCSS( optionsCSS, 'options.min.css' )
}

function buildBackgroundJS () {
  return buildJS( ['background.js'], 'background.min.js' )
}

function buildPopupJS () {
  return buildJS( popupJS, 'popup.min.js' )
}

function watch () {

  gulp.watch( contentCSS, buildContentCSS );

  gulp.watch( contentJS, buildContentJS );

  gulp.watch( optionsJS, buildOptionsJS );

  gulp.watch( optionsCSS, buildOptionsCSS );

  gulp.watch( ['background.js'], buildBackgroundJS );

  gulp.watch( popupJS, buildPopupJS );

  gulp.watch( [ '*.json', '*.html', '_locales/**/*', 'images/**/*', 'lib/images/**/*' ], copyProjectFiles );

}

/* task exports */
exports.watch = watch
exports.build = gulp.series( gulp.parallel( buildContentCSS, buildContentJS, buildBackgroundJS, buildPopupJS, buildOptionsCSS, buildOptionsJS ), copyProjectFiles )
exports.package = package
