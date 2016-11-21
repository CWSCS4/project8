#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const Simultaneity = require(__dirname + '/simultaneity.js')

if (process.argv.length !== 3) throw new Error('Incorrect syntax. Use: ./compile-vm-project.js DIR')

const POP_INTO_D = [
	'@SP',
	'AM=M-1', //A = --SP
	'D=M' //D = *(--SP)
]
const LOAD_STACK_TOP = [
	'@SP',
	'A=M-1' //A = SP - 1
]
const SAVED_VALUE_LOCATION_TEMP = '@R14'
function incrementR14AndSaveInstructions(loadLocation) {
	return [
		loadLocation,
		'D=M', //D = *loadLocation
		SAVED_VALUE_LOCATION_TEMP,
		'AM=M+1', //A = ++SAVED_VALUE_LOCATION
		'M=D' //*(++SAVED_VALUE_LOCATION) = *loadLocation
	]
}
let callLabelID = 0
/*
	call is responsible for:
	- Pushing return location, LCL, ARGS, THIS, and THAT onto global stack
	- Setting ARG to location of first arg on stack
		- Necessary even if args == 0 since args specifies where to put the return value
	- Setting LCL to top of global stack
	- Jumping to callee
*/
class CallInstruction {
	constructor([functionName, args]) {
		const returnLabel = 'AFTER_CALL_' + functionName + '_' + String(callLabelID++)
		let r14Initial
		if (args === '0') r14Initial = 'D+1' //leave a space for the return value from callee
		else r14Initial = 'D'
		this.instructions = [
			//Get location of save segment into R14
			'@SP',
			'D=M', //D = SP
			SAVED_VALUE_LOCATION_TEMP,
			'M=' + r14Initial, //SAVED_VALUE_LOCATION = SP or SP + 1
			//Add return address to save segment
			'@' + returnLabel,
			'D=A', //D = returnLabel
			SAVED_VALUE_LOCATION_TEMP,
			'A=M', //A = SAVED_VALUE_LOCATION
			'M=D' //*SAVED_VALUE_LOCATION = returnLabel
		].concat(incrementR14AndSaveInstructions('@LCL'))
		.concat(incrementR14AndSaveInstructions('@ARG'))
		.concat(incrementR14AndSaveInstructions('@THIS'))
		.concat(incrementR14AndSaveInstructions('@THAT'))
		//Set @ARG for callee to be SP - args
		.concat(['@SP'])
		switch (args) {
			case '0': {
				this.instructions.push('D=M') //D = SP - args
				break
			}
			case '1': {
				this.instructions.push('D=M-1') //D = SP - args
				break
			}
			default: {
				this.instructions.push(
					'D=M', //D = SP
					'@' + args,
					'D=D-A' //D = SP - args
				)
			}
		}
		this.instructions.push(
			'@ARG',
			'M=D', //ARG = SP - args
			//Set @LCL for callee to be SP + 5
			SAVED_VALUE_LOCATION_TEMP,
			'D=M+1', //D = SAVED_VALUE_LOCATION + 1
			'@LCL',
			'M=D', //LCL = SAVED_VALUE_LOCATION + 1
			//Call function
			'@' + functionName,
			'0;JMP',
			'(' + returnLabel + ')'
		)
	}
	toHack() {
		return this.instructions
	}
}
let comparisonLabelID = 0
function comparisonInstructions(jmpTrue) {
	const jmpTrueLabel = jmpTrue + '_' + String(comparisonLabelID++) //guarantee no collisions
	const endLabel = 'END_' + jmpTrueLabel
	return twoOperandArithmetic({operator: '-', destination: 'D'})
		.concat([
			'@' + jmpTrueLabel,
			'D;J' + jmpTrue,
				'D=0', //if false, D = 0
				'@' + endLabel,
				'0;JMP',
			'(' + jmpTrueLabel + ')',
				'D=-1', //if true, D = -1
			'(' + endLabel + ')'
		])
		.concat(LOAD_STACK_TOP)
		.concat(['M=D']) //*(SP - 1) = (0 or -1)
}
const SYS_INIT = 'Sys.init'
/*
	function is responsible for:
	- Pushing 0 onto global stack for each local variable
	- Setting SP to location after last local variable
*/
class FunctionInstruction {
	constructor([name, localVariables]) {
		localVariables = Number(localVariables)
		this.instructions = [
			'(' + name + ')',
			'@LCL'
		]
		if (localVariables) {
			this.instructions.push('A=M') //A = LCL
			for (let i = 0; i < localVariables; i++) {
				let newLocationStore
				if (i === localVariables - 1) newLocationStore = 'D'
				else newLocationStore = 'A'
				this.instructions.push(
					'M=0', //*(LCL + i) = 0
					newLocationStore + '=A+1' //i++ first times, then D = LCL + localVariables last time
				)
			}
		}
		else this.instructions.push('D=M') //D = LCL
		this.instructions.push(
			'@SP',
			'M=D' //SP = LCL + localVariables
		)
		this.functionName = name
	}
	get name() {
		return this.functionName
	}
	toHack() {
		return this.instructions
	}
}
function getLabel({currentFunction, label}) {
	return currentFunction + '$' + label
}
function gotoInstructions({currentFunction, label, value}) {
	return [
		'@' + getLabel({currentFunction, label}),
		value + ';JNE'
	]
}
class GotoInstruction {
	constructor({instructionArguments: [label], currentFunction}) {
		this.instructions = gotoInstructions({currentFunction, label, value: '-1'})
	}
	toHack() {
		return this.instructions
	}
}
class IfGotoInstruction {
	constructor({instructionArguments: [label], currentFunction}) {
		this.instructions = POP_INTO_D
			.concat(gotoInstructions({currentFunction, label, value: 'D'}))
	}
	toHack() {
		return this.instructions
	}
}
class LabelInstruction {
	constructor({instructionArguments: [label], currentFunction}) {
		this.instructions = ['(' + getLabel({currentFunction, label}) + ')']
	}
	toHack() {
		return this.instructions
	}
}
function getVariableSegmentStartIntoD(segment) {
	let segmentStartPointer
	switch (segment) {
		case 'argument': {
			segmentStartPointer = '@ARG'
			break
		}
		case 'local': {
			segmentStartPointer = '@LCL'
			break
		}
		case 'this': {
			segmentStartPointer = '@THIS'
			break
		}
		case 'that': {
			segmentStartPointer = '@THAT'
			break
		}
		default: throw new Error('Segment "' + segment + '" is not a variable segment')
	}
	return [
		segmentStartPointer,
		'D=M' //D = ARG or LCL or THIS or THAT
	]
}
const TEMP_SEGMENT_START = 5
function getPositionIntoD({positionArguments, className}) {
	const [segment, offset] = positionArguments
	switch (segment) {
		case 'argument':
		case 'local':
		case 'this':
		case 'that': {
			const instructions = getVariableSegmentStartIntoD(segment)
			switch (offset) {
				case '0': break
				case '1': {
					instructions[instructions.length - 1] += '+1' //D = [ARG or LCL or THIS or THAT] + 1
					break
				}
				default: {
					instructions.push(
						'@' + offset,
						'D=D+A' //D = segmentStart + offset
					)
				}
			}
			return instructions
		}
		case 'static': {
			return [
				'@' + className + '.' + offset,
				'D=A'
			]
		}
		case 'temp': {
			return [
				'@' + String(TEMP_SEGMENT_START + Number(offset)),
				'D=A' //D = TEMP_SEGMENT_START + offset
			]
		}
		case 'pointer': {
			let position
			switch (offset) {
				case '0': {
					position = '@THIS'
					break
				}
				case '1': {
					position = '@THAT'
					break
				}
				default: throw new Error('Unknown pointer offset: ' + offset)
			}
			return [
				position,
				'D=A' //D = &THIS or &THAT
			]
		}
		default: throw new Error('Unknown segment: "' + segment + '"')
	}
}
const POP_TEMP = '@R15'
class PopInstruction {
	constructor({positionArguments, className}) {
		this.instructions = getPositionIntoD({positionArguments, className})
			.concat([
				POP_TEMP,
				'M=D' //POP_TEMP = position
			])
			.concat(POP_INTO_D)
			.concat([
				POP_TEMP,
				'A=M', //A = position
				'M=D' //*position = popped
			])
	}
	toHack() {
		return this.instructions
	}
}
function getValueIntoD({positionArguments, className}) {
	const [segment, offset] = positionArguments
	switch (segment) {
		case 'constant': {
			switch (offset) {
				case '0': return ['D=0'] //D = offset
				case '1': return ['D=1'] //D = offset
				default: {
					return [
						'@' + offset,
						'D=A' //D = offset
					]
				}
			}
		}
		case 'argument':
		case 'local':
		case 'static':
		case 'this':
		case 'that':
		case 'pointer':
		case 'temp': {
			const intoDInstructions = getPositionIntoD({positionArguments, className})
			const lastInstruction = intoDInstructions[intoDInstructions.length - 1]
			if (lastInstruction === 'D=A') intoDInstructions.pop()
			else intoDInstructions[intoDInstructions.length - 1] = lastInstruction.replace('D=', 'A=')
			intoDInstructions.push('D=M')
			return intoDInstructions
		}
		default: throw new Error('Unknown segment: "' + segment + '"')
	}
}
class PushInstruction {
	constructor({positionArguments, className}) {
		this.instructions = getValueIntoD({positionArguments, className})
			.concat([
				'@SP',
				'M=M+1', //SP++
				'A=M-1', //A = SP - 1 (what SP was before incrementing)
				'M=D' //*(SP - 1) = D
			])
	}
	toHack() {
		return this.instructions
	}
}
function decrementR14AndLoadInstructions({saveLocation, useDLocation}) {
	let source
	if (useDLocation) source = 'D'
	else source = 'M'
	return [
		SAVED_VALUE_LOCATION_TEMP,
		'AM=' + source + '-1', //A = --SAVED_VALUE_LOCATION (or D-1)
		'D=M', //D = *(--SAVED_VALUE_LOCATION)
		saveLocation,
		'M=D' //*saveLocation = *(--SAVED_VALUE_LOCATION)
	]
}
/*
	return is responsible for:
	- Copying top of stack onto top of stack of caller
	- Restoring LCL-THAT of caller
	- Jumping back to caller
*/
const RETURN_INSTRUCTIONS = POP_INTO_D
	.concat([
		//Copy return value
		'@ARG',
		'A=M', //A=ARG
		'M=D', //*ARG = pop()
		//Save where SP needs to be reset for caller
		'D=A+1', //D = ARG + 1
		'@SP',
		'M=D', //SP = ARG + 1
		//Get location after last save value
		'@LCL',
		'D=M' //D = LCL
	])
	.concat(decrementR14AndLoadInstructions({saveLocation: '@THAT', useDLocation: true}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@THIS', useDLocation: false}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@ARG', useDLocation: false}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@LCL', useDLocation: false}))
	.concat([
		//Reset program location
		SAVED_VALUE_LOCATION_TEMP,
		'A=M-1', //A = SAVED_VALUE_LOCATION - 1
		'A=M', //A = *(SAVED_VALUE_LOCATION - 1)
		'0;JMP'
	])
function oneOperandArithmetic(operator) {
	return LOAD_STACK_TOP
		.concat(['M=' + operator + 'M'])
}
function twoOperandArithmetic({operator, destination}) {
	return POP_INTO_D
		.concat([
			'A=A-1', //A = SP - 1
			destination + '=M' + operator + 'D' //destination = *(SP - 1) [operator] *SP
		])
}
function twoOperandStackArithmetic(operator) {
	return twoOperandArithmetic({operator, destination: 'M'})
}
const ARITHMETIC_INSTRUCTIONS = {
	'add': twoOperandStackArithmetic('+'),
	'and': twoOperandStackArithmetic('&'),
	'neg': oneOperandArithmetic('-'),
	'not': oneOperandArithmetic('!'),
	'or': twoOperandStackArithmetic('|'),
	'sub': twoOperandStackArithmetic('-')
}
const COMPARISON_INSTRUCTION_CODES = {
	'gt': 'GT',
	'eq': 'EQ',
	'lt': 'LT'
}
const MEMORY_INSTRUCTION_CLASSES = {
	'pop': PopInstruction,
	'push': PushInstruction
}
/*
	Effectively calls Sys.init() except
	- No need to put save values onto global stack because Sys.init() can't return
	- No need to set ARG because Sys.init() gets no args and can't return a value
	So only has to
	- Set LCL to top of global stack
	- Jump to Sys.init()
*/
const INITIALIZATION_INSTRUCTIONS = [
	'@261', //256 + 5 because the proposed implementation needlessly adds save values before invoking Sys.init()
	'D=A', //D = 261
	'@LCL', //no need to set SP since it is set automatically in function initialization based off LCL
	'M=D', //LCL = 261
	'@' + SYS_INIT,
	'0;JMP'
]

function getLines(stream, lineCallback, endCallback) {
	let residual = ''
	stream.on('data', chunk => {
		chunk = chunk.toString()
		let lastConsumed = 0
		for (let i = 0; i < chunk.length; i++) {
			if (chunk[i] === '\n') {
				lineCallback(residual + chunk.substring(lastConsumed, i))
				residual = ''
				lastConsumed = i + 1
			}
		}
		residual += chunk.substring(lastConsumed)
	})
	stream.on('end', () => {
		lineCallback(residual)
		endCallback()
	})
}

const VM = '.vm'
const ASM = '.asm'
const EMPTY_LINE = /^\s*(?:\/\/.*)?$/
const filesInstructions = new Set //set of arrays of instructions for each file
function loadFile(fullFile, callback) {
	const inStream = fs.createReadStream(fullFile)
	inStream.on('error', err => {
		throw new Error('Could not find file: ' + fullFile)
	})
	const fileName = fullFile.substring(fullFile.lastIndexOf(path.sep) + 1)
	const className = fileName.substring(0, fileName.length - VM.length)
	const fileInstructions = []
	let currentFunction
	function parseLine(line) {
		const commandArguments = line.split(' ')
		const [command, ...instructionArguments] = commandArguments
		let instructions
		const arithmeticInstructions = ARITHMETIC_INSTRUCTIONS[command]
		if (arithmeticInstructions) instructions = arithmeticInstructions
		else {
			const comparisonInstructionCode = COMPARISON_INSTRUCTION_CODES[command]
			if (comparisonInstructionCode) instructions = comparisonInstructions(comparisonInstructionCode)
			else {
				const memoryInstructionClass = MEMORY_INSTRUCTION_CLASSES[command]
				if (memoryInstructionClass) {
					instructions = new memoryInstructionClass({
						positionArguments: instructionArguments,
						className
					}).toHack()
				}
				else {
					switch (command) {
						case 'call': {
							instructions = new CallInstruction(instructionArguments).toHack()
							break
						}
						case 'goto': {
							instructions = new GotoInstruction({instructionArguments, currentFunction}).toHack()
							break
						}
						case 'if-goto': {
							instructions = new IfGotoInstruction({instructionArguments, currentFunction}).toHack()
							break
						}
						case 'function': {
							const instruction = new FunctionInstruction(instructionArguments)
							instructions = instruction.toHack()
							currentFunction = instruction.name
							break
						}
						case 'label': {
							instructions = new LabelInstruction({instructionArguments, currentFunction}).toHack()
							break
						}
						case 'return': {
							instructions = RETURN_INSTRUCTIONS
							break
						}
						default: throw new Error('Unrecognized command in "' + line + '"')
					}
				}
			}
		}
		fileInstructions.push(...instructions)
	}
	getLines(inStream, line => {
		line = line.trim()
		if (EMPTY_LINE.test(line)) return
		//If first line is not a function call, assume project is a single function body
		//that wasn't wrapped in anything, and add a Sys.init label
		if (fileInstructions.length === 0 && !line.startsWith('function')) {
			fileInstructions.push('(' + SYS_INIT + ')')
			currentFunction = SYS_INIT
		}
		parseLine(line)
	}, () => {
		filesInstructions.add(fileInstructions)
		callback()
	})
}
function writeCombinedInstructions() {
	const outStream = fs.createWriteStream(outFile)
	function writeInstructions(instructions) {
		for (const line of instructions) {
			outStream.write(line)
			outStream.write('\n')
		}
	}
	writeInstructions(INITIALIZATION_INSTRUCTIONS)
	for (const fileInstructions of filesInstructions) writeInstructions(fileInstructions)
	outStream.end()
}
const file = path.resolve(process.argv[2])
const outFile = file + path.sep + file.substring(file.lastIndexOf(path.sep) + 1) + ASM
fs.readdir(file, (err, files) => {
	if (err) throw new Error('Not a directory: ' + file)
	const filesS = new Simultaneity
	let foundFile = false
	for (const vmFile of files) {
		if (!vmFile.endsWith(VM)) continue
		filesS.addTask(() => {
			loadFile(file + path.sep + vmFile, () => filesS.taskFinished())
		})
		foundFile = true
	}
	if (!foundFile) throw new Error('No .vm files found in ' + file)
	filesS.callback(writeCombinedInstructions)
})