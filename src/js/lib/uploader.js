import mime from 'mime'
import Converter from 'converter'
import Notices from 'notices'
import { rml } from 'compat'

const allowedExtensions   = _wpPluploadSettings.defaults.filters.mime_types[0].extensions.split(',')
const maxFileSize         = Math.min( 1024*1024*200, parseInt(_wpPluploadSettings.defaults.filters.max_file_size) ) // 100MB or uplaod max filesize

const sizeAllowed = file => {
	return !!file && file.size <= maxFileSize
}
const extensionAllowed = file => {
	return !!file && allowedExtensions.includes( mime.extension( file.type ) )
}


class WPUploader {
	static #workflow
	onUploaded = () => {}
	onProgress = () => {}
	onError    = () => {}
	#file

	#progressHandler = (up,args) => {
		if ( this.#isitMe(args) ) {
			this.onProgress( args.percent )
		}
	}
	#uploadedHandler = ( up, args, response ) => {
		if ( this.#isitMe(args) ) {
			this.onUploaded( args )
			this.#removeListeners()
		}
	}
	#errorHandler = ( up, args, c = 0 ) => {
		if ( this.#isitMe(args) ) {
			this.onError(args)
		}
	}

	#isitMe(args) {
		return this.#file.name === args.name && this.#file.size === args.size
	}

	static get ready() {
		return !! WPUploader.workflow.uploader.uploader && !! WPUploader.workflow.uploader.uploader.ready
	}

	static get workflow() {
		if ( ! WPUploader.#workflow ) {
			WPUploader.#workflow = wp.media.editor.open( window.wpActiveEditor, {
				frame:    'post',
				state:    'insert',
				title:    thepaste.l10n.copy_paste,
				multiple: false
			})
		}
		return WPUploader.#workflow
	}

	static get uploader() {
		return WPUploader.workflow.uploader.uploader.uploader
	}

	static get(file) {
		return new WPUploader(file)
	}

	constructor(file) {

		// sanitize file
		if ( ! file.name ) {
			file.name = Uploader.getFilename( mime.extension(file.type) )
		}

		this.#file = rml.file(file)

	}

	destructor() {
		WPUploader.workflow.close()
	}

	upload() {
		if ( WPUploader.ready ) {
			this.#upload()
		} else {
			WPUploader.workflow.once( 'uploader:ready', () => {
				this.#upload()
			} );
		}
	}
	#upload() {
		this.#addListeners()
		WPUploader.uploader.addFile( this.#file );
		WPUploader.workflow.close()
	}

	#addListeners() {
		WPUploader.uploader.bind( 'UploadProgress', this.#progressHandler, this );
		WPUploader.uploader.bind( 'FileUploaded', this.#uploadedHandler, this );
		WPUploader.uploader.bind( 'Error', this.#errorHandler, this );
	}

	#removeListeners() {
		WPUploader.uploader.unbind( 'UploadProgress', this.#progressHandler, this );
		WPUploader.uploader.unbind( 'FileUploaded', this.#uploadedHandler, this );
		WPUploader.uploader.unbind( 'Error', this.#errorHandler, this );
	}

	dump() {
		console.log(arguments)
	}
}


const Uploader = {
	/**
	 *	Replace a placeholder element inside the tinyMCE document with the given html,
	 *	keeping the position of the pasted image in the content flow.
	 *
	 *	@param {Object} editor      tinyMCE editor instance
	 *	@param {Element} placeholder progress element inside the editor document
	 *	@param {String} html        markup of the uploaded attachment
	 */
	replaceInEditor: ( editor, placeholder, html ) => {
		const target = Uploader.imageBlock( editor, placeholder )

		// Fall back to a plain insert at the caret when the placeholder is gone
		// (e.g. the phrase was emptied by an editor command in the meantime).
		if ( ! target || ! target.parentNode ) {
			editor.execCommand( 'mceInsertContent', false, html )
			return
		}

		// `mceInsertContent` writes into the current selection, so move the caret
		// into the (now empty) target block before inserting
		editor.selection.select( target, true )
		editor.execCommand( 'mceInsertContent', false, html )
	},
	/**
	 *	Make sure the placeholder is the only child of its own block element and
	 *	return that block. Pasting into rich text frequently places the image
	 *	inside an existing paragraph next to text - splitting it here gives the
	 *	image a paragraph of its own, which keeps `<p>` groups separated.
	 *
	 *	@param {Object} editor      tinyMCE editor instance
	 *	@param {Element} placeholder progress element inside the editor document
	 *	@return {Element} the (empty) block the image should be inserted into
	 */
	imageBlock: ( editor, placeholder ) => {
		const body = editor.getBody()
		const parent = placeholder.parentNode

		if ( ! body || ! parent ) {
			return null
		}

		// placeholder is not inside a block: wrap it in a paragraph.
		// insert relative to `parent` - `placeholder` is its child, not the body's.
		if ( parent === body || ! editor.dom.is( parent, editor.dom.isBlock ) ) {
			const block = editor.dom.create( 'p' )
			parent.insertBefore( block, placeholder )
			block.appendChild( placeholder )
			return block
		}

		const hasBefore = !! placeholder.previousSibling
		const hasAfter  = !! placeholder.nextSibling

		// the paragraph holds only the placeholder: use it as is
		if ( ! hasBefore && ! hasAfter ) {
			parent.removeChild( placeholder )
			return parent
		}

		// split the paragraph: leading text stays, trailing text moves to a clone,
		// and the (empty) original keeps the image
		const trailing = hasAfter ? parent.cloneNode( false ) : null

		if ( hasAfter ) {
			while ( placeholder.nextSibling ) {
				trailing.appendChild( placeholder.nextSibling )
			}
			if ( parent.parentNode ) {
				parent.parentNode.insertBefore( trailing, parent.nextSibling )
			}
		}

		// drop everything in front of the placeholder so the block is empty again
		while ( placeholder.previousSibling ) {
			parent.removeChild( placeholder.previousSibling )
		}
		if ( placeholder.parentNode ) {
			placeholder.parentNode.removeChild( placeholder )
		}

		// nothing was in front of the image: the leading paragraph is empty now
		if ( ! parent.textContent.trim() && ! parent.querySelector( 'img,video,audio,iframe' ) ) {
			if ( parent.parentNode ) {
				parent.parentNode.removeChild( parent )
			}
			const block = editor.dom.create( 'p' )
			if ( trailing && trailing.parentNode ) {
				trailing.parentNode.insertBefore( block, trailing )
			} else {
				body.appendChild( block )
			}
			return block
		}

		// leading text remains: give the image a fresh paragraph right after it
		const block = editor.dom.create( 'p' )
		const anchor = parent.parentNode
		if ( ! anchor ) {
			body.appendChild( block )
		} else if ( trailing && trailing.parentNode === anchor ) {
			anchor.insertBefore( block, trailing )
		} else if ( parent.parentNode === anchor && parent.nextSibling ) {
			anchor.insertBefore( block, parent.nextSibling )
		} else if ( parent.parentNode === anchor ) {
			anchor.appendChild( block )
		} else {
			body.appendChild( block )
		}
		return block
	},
	inlineUpload: async el => {

		const file = await Converter.elementToFile( el )
		const uploader = WPUploader.get(file)
		const progress = document.createElement('progress')

		progress.classList.add('the-paste-progress')

		if ( ! sizeAllowed(file) ) {
			throw new ErrorEvent('the-paste-upload', { message: `File size exceeds ${maxFileSize} byte`,  })
		}

		if ( ! extensionAllowed(file) ) {
			throw new ErrorEvent('the-paste-upload', { message: `Type ${file.type} not allowed`,  })
		}
		// dom
		progress.max = 100
		el.parentNode?.insertBefore(progress,el)
		el.remove()
		// upload process
		uploader.onProgress = percent => {
			progress.value = percent
		}
		uploader.onError = error => {
			console.error(error)
			Notices.error( `<strong>${thepaste.l10n.the_paste}:</strong> ${error.message} File: <em>${file.name}</em>`, true )
			progress.remove()
		}
		uploader.onUploaded = args => {

			const newElement = document.createElement('p')
			const attachment = args.attachment.attributes
			const link = getUserSetting( 'urlbutton', 'none' )

			if ( 'image' === attachment.type ) {
				newElement.innerHTML = wp.media.string.image( {
					link,
					align: getUserSetting( 'align', 'none' ),
					size:  Uploader.getImageSize( attachment ),
				}, attachment )

			} else if ( 'video' === attachment.type ) {
				newElement.innerHTML = wp.media.string.video( {
					link: link !== 'none'
						? link
						: 'embed'
				}, attachment )

			} else if ( 'audio' === attachment.type ) {
				newElement.innerHTML = wp.media.string.audio( {
					link: link !== 'none'
						? link
						: 'embed'
				}, attachment )

			} else {
				newElement.innerHTML = wp.media.string.link( {
					link: link !== 'none'
						? link
						: 'file'
				}, attachment )
			}
			// The progress element lives inside the editor iframe (a separate document),
			// so replacing it in the parent document is a no-op. Use the editor API instead
			// to swap the placeholder in place - otherwise the image ends up at the
			// current cursor position (typically after all pasted text).
			if ( tinymce.activeEditor && el.ownerDocument === tinymce.activeEditor.getDoc() ) {
				Uploader.replaceInEditor( tinymce.activeEditor, progress, newElement.innerHTML )
			} else {
				progress.replaceWith( newElement.childNodes[0] )
			}
		}
		uploader.upload()
	},
	/**
	 *	Resolve the image size for pasted images.
	 *
	 *	Prefers the size the user picked in the media modal. Falls back to `large`
	 *	instead of WordPress' `medium` default, as pasted content is usually the
	 *	main body image and looks too small at medium size.
	 *
	 *	@param {Object} attachment attachment attributes
	 *	@return {String} size name
	 */
	getImageSize: attachment => {
		const sizes = attachment?.sizes ?? {}
		const preferred = 'large'

		// explicit user choice in the media modal wins
		const userSize = getUserSetting( 'imgsize' )
		if ( userSize && sizes[ userSize ] ) {
			return userSize
		}

		// requested default, if the attachment actually has that size
		if ( sizes[ preferred ] ) {
			return preferred
		}

		// largest available size as a last resort
		const available = Object.keys( sizes )
		if ( available.length ) {
			return available.includes( 'full' ) ? 'full' : available[ available.length - 1 ]
		}

		return 'full'
	},
	/**
	 *	Generate a filename
	 */
	getFilename: suffix => {

		const zerofill = (n,len = 2) => {
			return ('00' + n.toString()).substr(-len)
		}

		let name = thepaste.options.default_filename

		const now = new Date(),
			postname = document.querySelector('#post [name="post_title"]#title').value,
			username = document.querySelector('.display-name').textContent,
			map = [
				{ s: '%Y', r: now.getFullYear() },
				{ s: '%y', r: now.getFullYear() % 100 },
				{ s: '%m', r: zerofill(now.getMonth() + 1) },
				{ s: '%d', r: zerofill(now.getDate()) },
				{ s: '%e', r: now.getDate() },
				{ s: '%H', r: zerofill(now.getHours()) },
				{ s: '%I', r: zerofill(now.getHours() % 12 ) },
				{ s: '%M', r: zerofill(now.getMinutes()) },
				{ s: '%S', r: zerofill(now.getSeconds()) },
				{ s: '%s', r: Math.floor( now.getTime() / 1000 ) }
			];
		if ( 'undefined' !== typeof postname ) {
			map.push( { s: '<postname>', r: postname } );
		} else {
			map.push( { s: '<postname>', r: '' } );
		}
		map.forEach( function(el) {
			name = name.replace( el.s, el.r )
		})
		if ( 'string' === typeof suffix) {
			name += '.' + suffix;
		}
		return name;
	}
}
module.exports = Uploader
