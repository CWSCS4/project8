#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const Simultaneity = require(__dirname + '/simultaneity.js')

if (process.argv.length !== 3) throw new Error('Incorrect syntax. Use: ./compile-vm.js FILE.vm|DIR')

const POP_INTO_D = [
	'@SP',
	'AM=M-1',
	'D=M'
]
const LOAD_STACK_TOP = [
	'@SP',
	'A=M-1'
]
function incrementR14AndSaveInstructions(loadLocation) {
	return [
		loadLocation,
		'D=M',
		'@R14',
		'AM=M+1',
		'M=D'
	]
}
let callLabelID = 0
class CallInstruction {
	constructor([functionName, args]) {
		const returnLabel = 'CALL_' + String(callLabelID++)
		let r14Initial
		if (args === '0') r14Initial = 'D+1' //leave a space for the return value from callee
		else r14Initial = 'D'
		this.instructions = [
			//Get location of save segment into R14
			'@SP',
			'D=M',
			'@R14',
			'M=' + r14Initial,
			//Add return address to save segment
			'@' + returnLabel,
			'D=A',
			'@R14',
			'A=M',
			'M=D'
		].concat(incrementR14AndSaveInstructions('@LCL'))
		.concat(incrementR14AndSaveInstructions('@ARG'))
		.concat(incrementR14AndSaveInstructions('@THIS'))
		.concat(incrementR14AndSaveInstructions('@THAT'))
		.concat([
			//Set @ARG for callee to be SP - args
			'@SP',
			'D=M',
			'@' + args,
			'D=D-A',
			'@ARG',
			'M=D',
			//Set @LCL for callee to be SP + 5
			'@R14',
			'D=M+1',
			'@LCL',
			'M=D',
			//Call function
			'@' + functionName,
			'0;JMP',
			'(' + returnLabel + ')'
		])
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
			'D=0',
			'@' + endLabel,
			'0;JMP',
			'(' + jmpTrueLabel + ')',
			'D=-1',
			'(' + endLabel + ')'
		])
		.concat(LOAD_STACK_TOP)
		.concat(['M=D'])
}
const FUNCTION_NAMES = new Set
const SYS_INIT = 'Sys.init'
class FunctionInstruction {
	constructor([name, localVariables]) {
		localVariables = Number(localVariables)
		this.instructions = [
			'(' + name + ')',
			'@LCL',
			'A=M'
		]
		for (let i = 0; i < localVariables; i++) {
			this.instructions.push(
				'M=0',
				'A=A+1'
			)
		}
		this.instructions.push(
			'D=A',
			'@SP',
			'M=D'
		)
		FUNCTION_NAMES.add(name)
		this.functionName = name
	}
	get name() {
		return this.functionName
	}
	toHack() {
		return this.instructions
	}
	static get foundInit() {
		if (FUNCTION_NAMES.has(SYS_INIT)) return true
		if (FUNCTION_NAMES.size !== 1) throw new Error('Expected only 1 function in project')
		return false
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
		default: {
			throw new Error('Segment "' + segment + '" is not a variable segment')
		}
	}
	return [
		segmentStartPointer,
		'D=M'
	]
}
const TEMP_SEGMENT_OFFSET = 5
function getPositionIntoD({positionArguments, className}) {
	const [segment, offset] = positionArguments
	switch (segment) {
		case 'argument':
		case 'local':
		case 'this':
		case 'that': {
			const instructions = getVariableSegmentStartIntoD(segment)
			if (offset !== '0') {
				instructions.push(
					'@' + offset,
					'D=D+A'
				)
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
				'@' + String(TEMP_SEGMENT_OFFSET + Number(offset)),
				'D=A'
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
				default: {
					throw new Error('Unknown pointer offset: ' + offset)
				}
			}
			return [
				position,
				'D=A'
			]
		}
		default: {
			throw new Error('Unknown segment: "' + segment + '"')
		}
	}
}
const POP_TEMP = '@R15'
class PopInstruction {
	constructor({positionArguments, className}) {
		this.instructions = getPositionIntoD({positionArguments, className})
			.concat([
				POP_TEMP,
				'M=D'
			])
			.concat(POP_INTO_D)
			.concat([
				POP_TEMP,
				'A=M',
				'M=D'
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
			return [
				'@' + offset,
				'D=A'
			]
			break
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
		default: {
			throw new Error('Unknown segment: "' + segment + '"')
		}
	}
}
class PushInstruction {
	constructor({positionArguments, className}) {
		this.instructions = getValueIntoD({positionArguments, className})
			.concat([
				'@SP',
				'M=M+1',
				'A=M-1',
				'M=D'
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
		'@R14',
		'AM=' + source + '-1',
		'D=M',
		saveLocation,
		'M=D'
	]
}
const RETURN_INSTRUCTIONS = POP_INTO_D
	.concat([
		//Copy return value
		'@ARG',
		'A=M',
		'M=D',
		//Save where SP needs to be reset for caller
		'@ARG',
		'D=M+1',
		'@R13',
		'M=D',
		//Get location after last save value
		'@LCL',
		'D=M'
	])
	.concat(decrementR14AndLoadInstructions({saveLocation: '@THAT', useDLocation: true}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@THIS', useDLocation: false}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@ARG', useDLocation: false}))
	.concat(decrementR14AndLoadInstructions({saveLocation: '@LCL', useDLocation: false}))
	.concat([
		//Reset SP
		'@R13',
		'D=M',
		'@SP',
		'M=D',
		//Reset program location
		'@R14',
		'A=M-1',
		'A=M',
		'0;JMP'
	])
function oneOperandArithmetic(operator) {
	return LOAD_STACK_TOP
		.concat(['M=' + operator + 'M'])
}
function twoOperandArithmetic({operator, destination}) {
	return POP_INTO_D
		.concat([
			'A=A-1',
			destination + '=M' + operator + 'D'
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
function initializationInstructions() {
	const instructions = [
		/*'@256',
		'D=A',
		'@SP',
		'M=D',
		'@LCL',
		'M=D'*/
	]
	if (FunctionInstruction.foundInit) {
		instructions.push(
			'@' + SYS_INIT,
			'0;JMP'
		)
	}
	return instructions
}

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
const filesInstructions = new Set //set of arrays of instructions for each file
function loadFile(fullFile, callback) {
	const inStream = fs.createReadStream(fullFile)
	inStream.on('error', err => {
		throw new Error('Could not find file: ' + fullFile)
	})
	const className = fullFile.substring(fullFile.lastIndexOf(path.sep) + 1)
	const EMPTY_LINE = /^\s*(?:\/\/.*)?$/
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
		if (fileInstructions.length === 0 && !line.startsWith('function')) { //if first line is not a function call, assume it is just a single function body that wasn't wrapped in anything
			fileInstructions.push('(' + SYS_INIT + ')')
			currentFunction = SYS_INIT
			FUNCTION_NAMES.add(SYS_INIT)
		}
		parseLine(line)
	}, () => {
		filesInstructions.add(fileInstructions)
		callback()
	})
}
function writeCombinedInstructions() {
	const outStream = fs.createWriteStream(rootFile + ASM)
	function writeInstructions(instructions) {
		for (const line of instructions) {
			outStream.write(line)
			outStream.write('\n')
		}
	}
	writeInstructions(initializationInstructions())
	for (const fileInstructions of filesInstructions) writeInstructions(fileInstructions)
	outStream.end()
}
const file = path.resolve(process.argv[2])
let rootFile
if (file.endsWith(VM)) {
	rootFile = file.substring(0, file.length - VM.length)
	loadFile(file, writeCombinedInstructions)
}
else {
	fs.readdir(file, (err, files) => {
		if (err) throw new Error('Not a directory or VM file: ' + file)
		rootFile = file + path.sep + file.substring(file.lastIndexOf(path.sep) + 1)
		const filesS = new Simultaneity
		for (const vmFile of files) {
			if (!vmFile.endsWith(VM)) continue
			filesS.addTask(() => {
				loadFile(file + path.sep + vmFile, () => filesS.taskFinished())
			})
		}
		filesS.callback(writeCombinedInstructions)
	})
}